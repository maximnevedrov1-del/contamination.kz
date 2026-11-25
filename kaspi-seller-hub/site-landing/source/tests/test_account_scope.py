"""UI access boundary is clear throughout the connection simulation; not a backend security audit."""
import unittest
from playwright.sync_api import sync_playwright

class AccountScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p=sync_playwright().start()
        cls.browser=cls.p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.p.stop()
    def setUp(self):
        self.page=self.browser.new_page(viewport={'width':1440,'height':900},reduced_motion='reduce')
        self.page.goto('http://127.0.0.1:3000/',wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        self.root=self.page.locator('#connection-demo')
    def tearDown(self): self.page.close()
    def test_bank_remains_unconnected_through_shop_connection(self):
        scope=self.root.locator('[data-account-scope]')
        self.assertEqual(scope.count(),1,'Connection must show the access boundary, not only copy/paste')
        for phase in range(5):
            self.root.locator(f'[data-connect-step="{phase}"]').click()
            self.assertEqual(scope.locator('[data-banking-access]').get_attribute('data-banking-access'),'not-connected')
            self.assertEqual(scope.locator('input,textarea,[contenteditable="true"]').count(),0)
        self.assertEqual(self.root.locator('[data-connect-store-count]').inner_text(),'3')
    def test_explanation_accessible_at_all_sizes(self):
        scope=self.root.locator('[data-account-scope]')
        self.assertEqual(scope.count(),1,'Missing visible shop vs bank scope explanation')
        for width,height in [(1440,900),(768,1024),(1024,768),(375,812)]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':height})
                detail=scope.locator('[data-account-explainer]')
                detail.locator('summary').click()
                self.assertTrue(detail.locator('p').first.is_visible())
                detail.locator('summary').click()
                self.assertFalse(detail.locator('p').first.is_visible())
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
                sizes=scope.locator('small,button,summary').evaluate_all('(els)=>els.filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize))')
                self.assertTrue(sizes and min(sizes)>=14)

if __name__=='__main__':unittest.main()
