"""Safari-compatible engine coverage (emulated viewport, not a physical iPad)."""
import unittest
from playwright.sync_api import sync_playwright

class WebKitDisplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p=sync_playwright().start()
        cls.browser=cls.p.webkit.launch()
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.p.stop()
    def test_desktop_and_tablet_animations_and_controls(self):
        for width,height in [(1440,900),(768,1024),(1024,768)]:
            with self.subTest(width=width,height=height):
                page=self.browser.new_page(viewport={'width':width,'height':height},reduced_motion='no-preference')
                errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto('http://127.0.0.1:3000/',wait_until='networkidle')
                page.add_style_tag(content='html{scroll-behavior:auto!important}')
                for id,toggle in [('live-demo','data-demo-toggle'),('connection-demo','data-connect-toggle'),('picker-demo','data-picker-toggle')]:
                    root=page.locator('#'+id)
                    root.scroll_into_view_if_needed()
                    page.wait_for_timeout(350)
                    self.assertEqual(root.get_attribute('data-running'),'true',id)
                    phase=root.get_attribute('data-phase')
                    page.wait_for_timeout(3300)
                    self.assertNotEqual(root.get_attribute('data-phase'),phase,id)
                    root.locator('['+toggle+']').click()
                    self.assertEqual(root.get_attribute('data-running'),'false',id)
                self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'),width)
                self.assertFalse(errors)
                page.close()

if __name__=='__main__':unittest.main()
