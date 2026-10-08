//! Names for files the app saves (the browser's downloads).

/// `name`, or `name (1)`, `name (2)`, ... before its extension, the first that is not `taken`.
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    // The extension is from the first dot after the first character (a dot file has none).
    let (stem, ext) = match name.char_indices().skip(1).find(|&(_, c)| c == '.') {
        Some((i, _)) => name.split_at(i),
        None => (name, ""),
    };
    (1..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !taken(candidate))
        .expect("an unused name")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_name_stays() {
        assert_eq!(unique_name("report.pdf", |_| false), "report.pdf");
    }

    #[test]
    fn a_taken_name_gets_a_number_before_its_extension() {
        assert_eq!(unique_name("report.pdf", |n| n == "report.pdf"), "report (1).pdf");
        assert_eq!(unique_name("report.pdf", |n| n == "report.pdf" || n == "report (1).pdf"), "report (2).pdf");
    }

    #[test]
    fn a_name_without_an_extension_gets_the_number_at_the_end() {
        assert_eq!(unique_name("README", |n| n == "README"), "README (1)");
    }

    #[test]
    fn a_dot_file_keeps_its_name_whole() {
        assert_eq!(unique_name(".env", |n| n == ".env"), ".env (1)");
    }

    #[test]
    fn a_double_extension_keeps_both() {
        assert_eq!(unique_name("logs.tar.gz", |n| n == "logs.tar.gz"), "logs (1).tar.gz");
    }
}
