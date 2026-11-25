"""Readability and autoplay regression for desktop, tablet and phone."""
import unittest
from playwright.sync_api import sync_playwright

class DisplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p=sync_playwright().start()
        cls.browser=cls.p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.p.stop()
    def setUp(self):
        self.page=self.browser.new_page(viewport={'width':1440,'height':900},reduced_motion='no-preference')
        self.errors=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.goto('http://127.0.0.1:3000/',wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        self.page.locator('h1').wait_for()
    def tearDown(self): self.page.close()
    def test_dashboard_labels_readable_at_each_breakpoint(self):
        selectors=['.demo-metrics small','.connect-form-label','.picker-person-metrics small','.dash-label','.screen-content small','.role-panel small']
        for width,height in [(1440,900),(1920,1080),(768,1024),(1024,768),(375,812)]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':height})
                minimum=13 if width<600 else 14
                for selector in selectors:
                    for size in self.page.locator(selector).evaluate_all('(els)=>els.filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize))'):
                        self.assertGreaterEqual(size,minimum,selector)
                self.assertGreaterEqual(self.page.locator('.hero-lead').evaluate('(e)=>parseFloat(getComputedStyle(e).fontSize)'),16)
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
                for selector in ['.dashboard-card','.screen-shell']:
                    scale=self.page.locator(selector).evaluate('(e)=>getComputedStyle(e).transform')
                    self.assertTrue(scale=='none' or scale.startswith('matrix(1,'),(selector,scale))
    def test_autoplay_when_dashboard_visible_not_just_heading(self):
        for selector,button in [('#live-demo','.live-demo-player'),('#connection-demo','.connection-player'),('#picker-demo','.picker-player')]:
            with self.subTest(demo=selector):
                root=self.page.locator(selector)
                self.page.locator(button).scroll_into_view_if_needed()
                self.page.wait_for_timeout(300)
                self.assertEqual(root.get_attribute('data-running'),'true')
                old=self.page.locator(button).inner_text()
                self.page.wait_for_timeout(3400)
                self.assertNotEqual(self.page.locator(button).inner_text(),old)
        self.assertFalse(self.errors)
    def test_reduced_motion_hint_and_manual_play(self):
        self.page.emulate_media(reduced_motion='reduce')
        self.page.reload(wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        for selector,toggle in [('#live-demo','[data-demo-toggle]'),('#connection-demo','[data-connect-toggle]'),('#picker-demo','[data-picker-toggle]')]:
            with self.subTest(demo=selector):
                root=self.page.locator(selector)
                root.scroll_into_view_if_needed()
                self.assertEqual(root.get_attribute('data-running'),'false')
                self.assertTrue(root.locator('[data-motion-note]').is_visible())
                root.locator(toggle).click()
                self.assertEqual(root.get_attribute('data-running'),'true')
                phase=root.get_attribute('data-phase')
                self.page.wait_for_timeout(3400)
                self.assertNotEqual(root.get_attribute('data-phase'),phase)
    def test_hero_activity_keeps_running_while_visible(self):
        card=self.page.locator('.hero-visual .sync-ring').first
        animations=card.evaluate('(e)=>e.getAnimations().map(a=>a.effect.getTiming().iterations)')
        self.assertIn(float('inf'),animations,'Hero activity must remain live, not finish after two repeats')

    def test_phone_step_labels_not_clipped(self):
        self.page.set_viewport_size({'width':375,'height':812})
        self.page.evaluate('document.fonts.ready')
        for selector in ['.connection-step-controls b','.picker-phase-controls b']:
            for box in self.page.locator(selector).evaluate_all('(els)=>els.map(e=>({width:e.clientWidth,content:e.scrollWidth}))'):
                self.assertLessEqual(box['content'],box['width']+2,selector)

    def test_dashboard_controls_have_touch_sized_targets(self):
        self.page.set_viewport_size({'width':768,'height':1024})
        for selector in ['.demo-player-controls button','.connection-step-controls button','.picker-phase-controls button']:
            for height in self.page.locator(selector).evaluate_all('(els)=>els.map(e=>e.getBoundingClientRect().height)'):
                self.assertGreaterEqual(height,44,selector)

if __name__=='__main__':unittest.main()
