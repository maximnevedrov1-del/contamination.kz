"""Connection walkthrough stays a local simulation and never accepts real credentials."""
import unittest
from playwright.sync_api import sync_playwright

class ConnectionDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':1280,'height':1000}, reduced_motion='reduce')
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto('http://127.0.0.1:3000/', wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        self.page.locator('h1').wait_for()

    def tearDown(self):
        self.page.close()

    def demo(self):
        root = self.page.locator('#connection-demo')
        self.assertEqual(root.count(), 1, 'Landing must show the animated copy/paste connection walkthrough')
        root.scroll_into_view_if_needed()
        return root

    def test_copy_paste_and_connected_dashboard(self):
        root = self.demo()
        root.locator('[data-connect-step="1"]').click()
        self.assertEqual(root.locator('[data-connect-copy]').inner_text(), 'Скопировано')
        root.locator('[data-connect-step="2"]').click()
        self.assertTrue(root.locator('[data-connect-token]').inner_text().startswith('DEMO-'))
        root.locator('[data-connect-step="3"]').click()
        self.assertIn('Проверяем', root.locator('[data-connect-state]').inner_text())
        root.locator('[data-connect-step="4"]').click()
        self.assertEqual(root.locator('[data-connect-state]').inner_text(), 'Магазин подключён · демо')
        self.assertEqual(root.locator('[data-connect-store-count]').inner_text(), '3')
        self.assertFalse(self.errors)

    def test_no_real_credentials_clipboard_storage_or_network(self):
        root = self.demo()
        requests = []
        self.page.on('request', lambda request: requests.append(request))
        for phase in range(5):
            root.locator(f'[data-connect-step="{phase}"]').click()
        self.assertEqual(root.locator('input,textarea,[contenteditable="true"]').count(), 0)
        self.assertFalse(any(r.method != 'GET' or 'DEMO-' in (r.post_data or '') or 'DEMO-' in r.url or 'kaspi.kz/shop/api' in r.url for r in requests))
        self.assertFalse(self.page.evaluate("Object.values(localStorage).concat(Object.values(sessionStorage)).some(v=>v.includes('DEMO-'))"))
        root.locator('[data-connect-policy] summary').click()
        self.assertTrue(root.locator('[data-connect-policy] p').first.is_visible())

    def test_direct_buttons_show_check_before_success(self):
        root = self.demo()
        root.locator('[data-connect-copy]').click()
        self.assertEqual(root.get_attribute('data-phase'), '1')
        self.assertEqual(root.locator('[data-connect-copy] svg').count(), 1)
        root.locator('[data-connect-paste]').click()
        self.assertEqual(root.get_attribute('data-phase'), '2')
        root.locator('[data-connect-add]').click()
        self.assertEqual(root.get_attribute('data-phase'), '3')
        self.assertIn('Проверяем', root.locator('[data-connect-state]').inner_text())
        self.page.wait_for_timeout(3000)
        self.assertEqual(root.get_attribute('data-phase'), '4')
        root.locator('[data-connect-toggle]').click()

    def test_repeated_mount_keeps_one_working_demo(self):
        self.demo()
        self.page.evaluate("async () => {const {mountConnectionDemo} = await import('/src/connection-demo.js'); mountConnectionDemo(document.querySelector('#how'));}")
        self.assertEqual(self.page.locator('#connection-demo').count(), 1)
        self.page.locator('[data-connect-step="2"]').click()
        self.assertEqual(self.page.locator('#connection-demo').get_attribute('data-phase'), '2')

    def test_pause_restart_and_reduced_motion(self):
        root = self.demo()
        self.page.wait_for_timeout(2900)
        self.assertEqual(root.get_attribute('data-phase'), '0')
        root.locator('[data-connect-toggle]').click()
        self.page.wait_for_timeout(2900)
        self.assertEqual(root.get_attribute('data-phase'), '1')
        root.locator('[data-connect-toggle]').click()
        phase = root.get_attribute('data-phase')
        self.page.wait_for_timeout(2900)
        self.assertEqual(root.get_attribute('data-phase'), phase)
        root.locator('[data-connect-restart]').click()
        self.assertEqual(root.get_attribute('data-phase'), '0')
        self.assertEqual(root.locator('[data-connect-token]').inner_text(), 'Сюда вставляется API-токен')

    def test_mobile_controls_no_horizontal_overflow(self):
        self.page.set_viewport_size({'width':375,'height':812})
        root = self.demo()
        root.locator('[data-connect-step="4"]').click()
        self.assertTrue(root.locator('[data-connect-state]').is_visible())
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 375)
        self.assertFalse(self.errors)

if __name__ == '__main__':
    unittest.main()
