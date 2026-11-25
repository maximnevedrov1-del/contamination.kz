import json
import re
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


class Prompt3Tests(unittest.TestCase):
    def test_llms_uses_fourteen_day_trial_copy(self):
        text = (ROOT / 'public' / 'llms.txt').read_text()
        self.assertIn('- 14 дней бесплатно, до 3 магазинов, один пробный период на магазин', text)
        self.assertIn('- 3 дүкенге дейін 14 күн тегін, әр дүкенге бір рет', text)
        self.assertNotIn('30 дней ' + 'бесплатно', text)
        self.assertNotIn('30 күн ' + 'тегін', text)

    def test_index_has_absolute_social_preview_metadata_and_jsonld(self):
        html = (ROOT / 'index.html').read_text()
        for value in [
            'https://saudapulse.kz/',
            'https://saudapulse.kz/og.png',
            'og:type', 'og:locale', 'og:locale:alternate', 'og:image',
            'twitter:card', 'summary_large_image',
            'application/ld+json', 'SoftwareApplication', 'ИП «НЕВЕДРОВ»',
        ]:
            self.assertIn(value, html)
        self.assertNotIn('aggregateRating', html)
        self.assertEqual(html.count('application/ld+json'), 1)
        ld = re.search(r'<script type="application/ld\+json">\s*(.*?)\s*</script>', html, re.S)
        json.loads(ld.group(1))

    def test_og_png_has_required_dimensions_and_size(self):
        path = ROOT / 'public' / 'og.png'
        with Image.open(path) as image:
            self.assertEqual(image.size, (1200, 630))
        self.assertLessEqual(path.stat().st_size, 300 * 1024)

    def test_stale_project_copy_and_todo_are_removed(self):
        todo = ROOT / 'TODO.md'
        self.assertTrue(todo.exists())
        todo_text = todo.read_text()
        self.assertIn('SaudaPulse', todo_text)
        forbidden_product = 'Market' + 'Flow'
        self.assertNotIn(forbidden_product, todo_text)
        forbidden_terms = ['Alga' + 'Top', 'Zero-' + 'Knowledge']
        for directory in ['src', 'index.html', 'TODO.md']:
            base = ROOT / directory
            files = [base] if base.is_file() else list(base.rglob('*'))
            for path in files:
                if path.is_file() and path.suffix in {'.js', '.json', '.html', '.md'}:
                    text = path.read_text(errors='ignore')
                    self.assertNotIn(forbidden_product, text, str(path))
                    for term in forbidden_terms:
                        self.assertNotIn(term, text, str(path))


if __name__ == '__main__':
    unittest.main()
