//! A script read aloud by Gemini's text-to-speech (its Interactions API): a
//! request a piece, in one calm voice, joined into one recording with where
//! each segment starts. Flash TTS reads, and its Flash-Lite twin once Flash's
//! requests for the day run out (the free tier allows a few a day).
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

pub const MODEL: &str = "gemini-3.8-flash-tts";
/// Read with once MODEL's requests for the day run out (its quota is its own).
pub const FALLBACK_MODEL: &str = "gemini-3.8-flash-lite-tts";
const ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const VOICE: &str = "Kore";
const STYLE: &str = "ニュース番組のアナウンサーのように、落ち着いて淡々と、聞き取りやすい速さで";
/// Gemini's audio: 24 kHz, mono, 16-bit PCM.
const SAMPLE_RATE: u32 = 24_000;
const BYTES_PER_SAMPLE: u32 = 2;
/// The most one request reads: its audio stops near 11 minutes, about 4,000
/// characters of Japanese read at the voice's pace.
pub const MAX_PIECE_CHARS: usize = 3_000;
/// The silence after each segment.
const GAP_SECS: f64 = 0.8;
/// How long one request may take (four minutes of audio took under a minute).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long to wait before asking again when Gemini is busy (503).
const BUSY_WAIT: Duration = Duration::from_secs(30);
/// The most a response may be: four minutes of audio is about 15 MB in base64.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// The request reading `text` aloud with `model`.
pub fn body(model: &str, text: &str) -> Value {
    json!({
        "model": model,
        "input": [{"type": "user_input", "content": [{"type": "text", "text": text, "annotations": [{"type": "speech_metadata", "style": STYLE}]}]}],
        "response_format": {"type": "audio"},
        "generation_config": {"speech_config": [{"voice": VOICE}]},
    })
}

/// The recording (a WAV) in Gemini's response.
pub fn audio_of(response: &Value) -> Result<Vec<u8>, String> {
    let data = response["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .filter(|c| c["type"] == "audio")
        .filter_map(|c| c["data"].as_str())
        .last()
        .ok_or("Gemini の答えに音声がありません")?;
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("Gemini の音声を読めません: {e}"))
}

/// The samples of a WAV (its data chunk).
pub fn pcm_of(wav: &[u8]) -> Result<Vec<u8>, String> {
    if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("WAV ではありません".into());
    }
    let mut at = 12;
    while at + 8 <= wav.len() {
        let size = u32::from_le_bytes([wav[at + 4], wav[at + 5], wav[at + 6], wav[at + 7]]) as usize;
        let start = at + 8;
        if &wav[at..at + 4] == b"data" {
            return Ok(wav[start..(start + size).min(wav.len())].to_vec());
        }
        at = start + size + size % 2;
    }
    Err("WAV に音声がありません".into())
}

/// A WAV of Gemini's samples.
pub fn wav(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * BYTES_PER_SAMPLE).to_le_bytes());
    out.extend_from_slice(&(BYTES_PER_SAMPLE as u16).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// `text` cut into pieces one request reads, at the ends of sentences.
pub fn pieces(text: &str, max_chars: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut piece = String::new();
    for sentence in text.split_inclusive('。') {
        if !piece.is_empty() && piece.chars().count() + sentence.chars().count() > max_chars {
            out.push(std::mem::take(&mut piece));
        }
        piece.push_str(sentence);
        while piece.chars().count() > max_chars {
            let rest = piece.chars().skip(max_chars).collect();
            out.push(piece.chars().take(max_chars).collect());
            piece = rest;
        }
    }
    if !piece.is_empty() {
        out.push(piece);
    }
    out
}

/// The segments' samples one after another, a short silence after each, as
/// a WAV, and where each segment starts (in seconds).
pub fn join(segments: &[Vec<u8>]) -> (Vec<u8>, Vec<f64>) {
    let per_sec = (SAMPLE_RATE * BYTES_PER_SAMPLE) as f64;
    let gap = vec![0u8; (GAP_SECS * per_sec) as usize];
    let mut pcm = Vec::new();
    let mut starts = Vec::new();
    for segment in segments {
        starts.push(pcm.len() as f64 / per_sec);
        pcm.extend_from_slice(segment);
        pcm.extend_from_slice(&gap);
    }
    (wav(&pcm), starts)
}

/// What to try next after `model` answered `status` on attempt `attempt`
/// (from 0): Flash-Lite once Flash's day is used up (429), the same again
/// after a wait when Gemini is busy (503, once), else nothing.
pub fn next_try(model: &'static str, status: u16, attempt: u32) -> Option<(&'static str, Duration)> {
    match status {
        429 if model == MODEL => Some((FALLBACK_MODEL, Duration::ZERO)),
        503 if attempt == 0 => Some((model, BUSY_WAIT)),
        _ => None,
    }
}

/// Reads `text` (a piece, at most MAX_PIECE_CHARS) aloud with the API key
/// `key`: its samples.
pub fn speak(key: &str, text: &str) -> Result<Vec<u8>, String> {
    let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
    let config = ureq::Agent::config_builder().timeout_global(Some(REQUEST_TIMEOUT)).http_status_as_error(false).tls_config(tls).build();
    let agent = ureq::Agent::new_with_config(config);
    let mut model = MODEL;
    for attempt in 0.. {
        let mut response = agent.post(ENDPOINT).header("x-goog-api-key", key).send_json(body(model, text)).map_err(|e| format!("Gemini に届きません: {e}"))?;
        let status = response.status().as_u16();
        let answer: Value = response.body_mut().with_config().limit(MAX_RESPONSE_BYTES).read_json().map_err(|e| format!("Gemini の答えを読めません（{status}）: {e}"))?;
        if status == 200 {
            return pcm_of(&audio_of(&answer)?);
        }
        let why = format!("Gemini（{model}）: {status} {}", answer["error"]["message"].as_str().unwrap_or_default());
        let (next, wait) = next_try(model, status, attempt).ok_or(why)?;
        std::thread::sleep(wait);
        model = next;
    }
    unreachable!("the attempts end in an answer or an error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_one_calm_voice_reading_the_text() {
        let b = body(MODEL, "皆さんこんにちは。");
        assert_eq!(b["model"], MODEL);
        assert_eq!(b["input"][0]["content"][0]["text"], "皆さんこんにちは。");
        assert_eq!(b["input"][0]["content"][0]["annotations"][0]["type"], "speech_metadata");
        assert_eq!((b["response_format"]["type"].as_str(), b["generation_config"]["speech_config"][0]["voice"].as_str()), (Some("audio"), Some(VOICE)));
    }

    #[test]
    fn takes_the_recording_out_of_the_response() {
        let data = base64::engine::general_purpose::STANDARD.encode(b"RIFF....");
        let response = json!({"steps": [{"type": "user_input"}, {"type": "model_output", "content": [{"type": "audio", "data": data}]}]});
        assert_eq!(audio_of(&response).unwrap(), b"RIFF....");
        assert!(audio_of(&json!({"steps": []})).is_err());
    }

    #[test]
    fn a_wav_s_samples_come_back_as_they_went_in() {
        let pcm: Vec<u8> = (0..200u8).collect();
        let w = wav(&pcm);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(pcm_of(&w).unwrap(), pcm);
        assert!(pcm_of(b"not a wav").is_err());
    }

    #[test]
    fn cuts_a_long_text_at_the_ends_of_sentences() {
        assert_eq!(pieces("短い。文です。", 100), ["短い。文です。"]);
        assert_eq!(pieces("あいう。かきく。さしす。", 8), ["あいう。かきく。", "さしす。"]);
        assert_eq!(pieces("あいうえおかきくけこ。", 4), ["あいうえ", "おかきく", "けこ。"], "a sentence longer than a piece is cut anyway");
    }

    #[test]
    fn joins_the_segments_with_a_short_silence_after_each() {
        let second = vec![0u8; (SAMPLE_RATE * BYTES_PER_SAMPLE) as usize];
        let (w, starts) = join(&[second.clone(), second.clone()]);
        assert_eq!(starts, [0.0, 1.8]);
        assert_eq!(pcm_of(&w).unwrap().len(), (3.6 * (SAMPLE_RATE * BYTES_PER_SAMPLE) as f64) as usize);
    }

    #[test]
    fn falls_back_to_flash_lite_once_the_day_is_used_up_and_waits_when_busy() {
        assert_eq!(next_try(MODEL, 429, 0), Some((FALLBACK_MODEL, Duration::ZERO)));
        assert_eq!(next_try(FALLBACK_MODEL, 429, 1), None);
        assert_eq!(next_try(MODEL, 503, 0), Some((MODEL, BUSY_WAIT)));
        assert_eq!(next_try(MODEL, 503, 1), None, "busy again: given up");
        assert_eq!(next_try(MODEL, 400, 0), None);
    }
}
