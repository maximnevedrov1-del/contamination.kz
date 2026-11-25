"""Browser tests: status transitions, pause, restart and reduced-motion support."""
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

class LiveDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1280, 'height': 900})
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto('http://127.0.0.1:3000/', wait_until='domcontentloaded')
        self.page.add_style_tag(content='html {scroll-behavior: auto !important}')
        self.page.locator('h1').wait_for()

    def tearDown(self):
        self.page.close()

    def demo(self):
        demo = self.page.locator('#live-demo')
        self.assertEqual(demo.count(), 1, 'Landing page must include the animated product demonstration')
        demo.scroll_into_view_if_needed()
        return demo

    def test_demo_status_transitions(self):
        demo = self.demo()
        for phase, label in [(0, 'Новый'), (1, 'Принят'), (2, 'В сборке'), (3, 'Проверен'), (4, 'Накладная готова'), (5, 'Отгружен')]:
            demo.locator(f'[data-demo-step="{phase}"]').click()
            self.assertEqual(demo.locator('[data-demo-status]').inner_text(), label)
            self.assertEqual(demo.get_attribute('data-phase'), str(phase))
        self.assertEqual(demo.locator('[data-demo-shipped]').inner_text(), '13')
        self.assertEqual(demo.locator('[data-demo-revenue]').inner_text().replace('\u00a0', ' '), '248 500 ₸')
        self.assertEqual(demo.locator('[data-demo-announcer]').count(), 1)
        self.assertIn('Отгружен', demo.locator('[data-demo-announcer]').inner_text())
        self.assertFalse(self.errors)

    def test_pause_and_resume(self):
        demo = self.demo()
        demo.locator('[data-demo-toggle]').click()
        phase = demo.get_attribute('data-phase')
        self.page.wait_for_timeout(3400)
        self.assertEqual(demo.get_attribute('data-phase'), phase)
        demo.locator('[data-demo-toggle]').click()
        self.page.wait_for_timeout(3400)
        self.assertNotEqual(demo.get_attribute('data-phase'), phase)

    def test_restart_resets_sequence_and_metrics(self):
        demo = self.demo()
        demo.locator('[data-demo-step="5"]').click()
        demo.locator('[data-demo-restart]').click()
        self.assertEqual(demo.get_attribute('data-phase'), '0')
        self.assertEqual(demo.locator('[data-demo-shipped]').inner_text(), '12')
        self.assertEqual(demo.locator('[data-demo-status]').inner_text(), 'Новый')

    def test_autoplay_pauses_outside_viewport(self):
        demo = self.demo()
        self.page.locator('#pricing').scroll_into_view_if_needed()
        self.page.wait_for_timeout(250)
        phase = demo.get_attribute('data-phase')
        self.page.wait_for_timeout(3400)
        self.assertEqual(demo.get_attribute('data-phase'), phase)
        self.assertIn('Воспроизвести', demo.locator('[data-demo-toggle]').inner_text())

    def test_reduced_motion_requires_explicit_play(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.reload(wait_until='domcontentloaded')
        demo = self.demo()
        self.page.wait_for_timeout(3400)
        self.assertEqual(demo.get_attribute('data-phase'), '0')
        self.assertIn('Воспроизвести', demo.locator('[data-demo-toggle]').inner_text())
        demo.locator('[data-demo-step="2"]').click()
        self.assertEqual(demo.locator('[data-demo-status]').inner_text(), 'В сборке')
        self.assertEqual(demo.locator('.is-current .demo-step-progress i').evaluate('(el) => getComputedStyle(el).transform'), 'matrix(1, 0, 0, 1, 0, 0)')

    def test_mobile_controls_and_existing_interactions(self):
        self.page.set_viewport_size({'width': 375, 'height': 812})
        demo = self.demo()
        demo.locator('[data-demo-step="4"]').click()
        self.assertEqual(demo.locator('[data-demo-status]').inner_text(), 'Накладная готова')
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.page.locator('[data-screen="dashboard"]').click()
        self.assertTrue(self.page.locator('[data-pane="dashboard"]').is_visible())
        self.page.locator('[data-role="picker"]').click()
        self.assertTrue(self.page.locator('[data-role-panel="picker"]').is_visible())
        self.page.locator('#orders-range').evaluate('(el) => {el.value=100; el.dispatchEvent(new Event("input", {bubbles:true}));}')
        self.assertEqual(self.page.locator('#saved-minutes').inner_text(), '200 мин')
        self.assertFalse(self.errors)

if __name__ == '__main__':
    unittest.main()
