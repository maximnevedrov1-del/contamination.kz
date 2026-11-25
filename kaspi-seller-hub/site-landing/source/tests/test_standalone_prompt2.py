import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class StandalonePrompt2Tests(unittest.TestCase):
    def test_source_fonts_are_local_relative_and_swap(self):
        css = (ROOT / 'src' / 'fonts.css').read_text()
        self.assertEqual(css.count('font-display: swap'), 5)
        self.assertNotRegex(css, r'url\(/fonts/')
        self.assertEqual(len(re.findall(r"url\(['\"]?\.?/?fonts/manrope-\d+\.ttf", css)), 5)

    def test_standalone_contains_all_manrope_fonts_as_data_urls(self):
        html = (ROOT / 'public' / 'saudapulse-full.html').read_text()
        self.assertEqual(html.count('data:font/ttf;base64,'), 5)
        self.assertNotRegex(html, r'url\((?:/|\.\.?/)fonts/manrope-\d+\.ttf')


if __name__ == '__main__':
    unittest.main()
