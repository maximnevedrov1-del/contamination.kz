"""Two-picker comparison uses equivalent sample orders and controlled animation."""
import unittest
from playwright.sync_api import sync_playwright

class PickerDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = sync_playwright().start()
        cls.browser = cls.p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.p.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':1280,'height':1000}, reduced_motion='reduce')
        self.errors=[]
        self.page.on('pageerror', lambda e:self.errors.append(str(e)))
        self.page.goto('http://127.0.0.1:3000/',wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        self.page.locator('h1').wait_for()

    def tearDown(self):
        self.page.close()

    def demo(self):
        root=self.page.locator('#picker-demo')
        self.assertEqual(root.count(),1,'Comparison must include a live two-picker dashboard')
        root.scroll_into_view_if_needed()
        return root

    def test_speed_metrics_and_progress_for_equivalent_orders(self):
        root=self.demo()
        self.assertEqual(root.locator('[data-picker-card]').count(),2)
        self.assertEqual(root.locator('[data-picker="arman"] [data-speed]').inner_text(),'1,5')
        self.assertEqual(root.locator('[data-picker="aigerim"] [data-speed]').inner_text(),'1,0')
        root.locator('[data-picker-step="2"]').click()
        self.assertEqual(root.locator('[data-picker="arman"] [data-progress]').inner_text(),'6 / 6')
        self.assertEqual(root.locator('[data-picker="aigerim"] [data-progress]').inner_text(),'4 / 6')
        self.assertEqual(root.locator('[data-picker="arman"] [data-done]').inner_text(),'11')
        self.assertEqual(root.locator('[data-picker="aigerim"] [data-done]').inner_text(),'10')
        self.assertIn('2 мин', root.locator('[data-picker-insight]').inner_text())
        self.assertFalse(self.errors)

    def test_reassignment_preserves_total_pending_orders(self):
        root=self.demo()
        root.locator('[data-picker-step="3"]').click()
        self.assertEqual(root.locator('[data-picker="arman"] [data-queue]').inner_text(),'2')
        self.assertEqual(root.locator('[data-picker="aigerim"] [data-queue]').inner_text(),'5')
        root.locator('[data-picker-reassign]').click()
        self.assertEqual(root.locator('[data-picker="arman"] [data-queue]').inner_text(),'3')
        self.assertEqual(root.locator('[data-picker="aigerim"] [data-queue]').inner_text(),'4')
        self.assertIn('перенес',root.locator('[data-picker-notice]').inner_text().lower())
        root.locator('[data-picker-restart]').click()
        self.assertEqual(root.get_attribute('data-phase'),'0')
        self.assertEqual(root.locator('[data-picker="arman"] [data-progress]').inner_text(),'0 / 6')

    def test_play_pause_reduced_motion_and_offscreen_stop(self):
        root=self.demo()
        self.page.wait_for_timeout(3100)
        self.assertEqual(root.get_attribute('data-phase'),'0')
        root.locator('[data-picker-toggle]').click()
        self.page.wait_for_timeout(3100)
        self.assertEqual(root.get_attribute('data-phase'),'1')
        root.locator('[data-picker-toggle]').click()
        self.page.wait_for_timeout(3100)
        self.assertEqual(root.get_attribute('data-phase'),'1')
        root.locator('[data-picker-toggle]').click()
        self.page.locator('#pricing').scroll_into_view_if_needed()
        self.page.wait_for_timeout(200)
        phase=root.get_attribute('data-phase')
        self.page.wait_for_timeout(3100)
        self.assertEqual(root.get_attribute('data-phase'),phase)

    def test_mobile_controls_and_accessibility(self):
        self.page.set_viewport_size({'width':375,'height':812})
        root=self.demo()
        root.locator('[data-picker-step="4"]').click()
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),375)
        self.assertTrue(root.locator('[data-picker="aigerim"]').is_visible())
        self.assertIn('задани',root.locator('[data-picker-announcer]').inner_text().lower())
        self.assertFalse(self.errors)

if __name__=='__main__':
    unittest.main()
