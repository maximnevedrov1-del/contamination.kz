"""Express priority is visible, readiness requires checks, and demo never claims handover."""
import unittest
from playwright.sync_api import sync_playwright

class ExpressDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p=sync_playwright().start();cls.browser=cls.p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls): cls.browser.close();cls.p.stop()
    def setUp(self):
        self.page=self.browser.new_page(viewport={'width':1440,'height':1000},reduced_motion='reduce')
        self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.goto('http://127.0.0.1:3000/',wait_until='domcontentloaded')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
        self.root=self.page.locator('#express-demo')
        self.assertEqual(self.root.count(),1,'Missing Express priority and packing dashboard')
    def tearDown(self): self.page.close()
    def test_queue_prioritises_express_without_hiding_overdue_standard(self):
        ids=self.root.locator('[data-express-order-id]').evaluate_all('(els)=>els.map(e=>e.dataset.expressOrderId)')
        self.assertEqual(ids,['KSP-2199','KSP-2201','KSP-2203','KSP-2205'])
        self.root.locator('[data-express-filter="express"]').click()
        ids=self.root.locator('[data-express-order-id]').evaluate_all('(els)=>els.map(e=>e.dataset.expressOrderId)')
        self.assertEqual(ids,['KSP-2201','KSP-2203'])
        self.root.locator('[data-express-filter="all"]').click()
        self.assertEqual(self.root.locator('[data-express-order-id]').count(),4)
    def test_ready_requires_all_packing_checks_and_is_not_handover(self):
        self.root.locator('[data-express-step="2"]').click()
        ready=self.root.locator('[data-express-ready]')
        self.assertFalse(ready.is_enabled())
        for checkbox in self.root.locator('[data-pack-check]').all():checkbox.check()
        self.assertTrue(ready.is_enabled())
        ready.click()
        self.assertEqual(self.root.get_attribute('data-order-status'),'ready')
        self.assertEqual(self.root.get_attribute('data-phase'),'4')
        self.assertEqual(self.root.locator('[data-courier-handover]').get_attribute('data-courier-handover'),'not-confirmed')
        self.root.locator('[data-pack-check="0"]').uncheck()
        self.assertFalse(ready.is_enabled())
        self.assertNotEqual(self.root.get_attribute('data-order-status'),'ready')
    def test_step_navigation_does_not_verify_physical_packing(self):
        for step in (3,4):
            self.root.locator(f'[data-express-step="{step}"]').click()
            self.assertEqual(self.root.locator('[data-pack-check]:checked').count(),0)
            self.assertFalse(self.root.locator('[data-express-ready]').is_enabled())
            self.assertNotEqual(self.root.get_attribute('data-order-status'),'ready')
    def test_autoplay_never_verifies_employee_checks(self):
        self.root.locator('.express-player').scroll_into_view_if_needed()
        self.page.clock.install()
        self.root.locator('[data-express-toggle]').click()
        self.page.clock.run_for(12200)
        self.assertEqual(self.root.get_attribute('data-phase'),'4')
        self.assertEqual(self.root.locator('[data-pack-check]:checked').count(),0)
        self.assertNotEqual(self.root.get_attribute('data-order-status'),'ready')
    def test_motion_manual_play_pause_and_restart(self):
        player=self.root.locator('.express-player');player.scroll_into_view_if_needed()
        self.page.wait_for_timeout(3100)
        self.assertEqual(self.root.get_attribute('data-phase'),'0')
        self.root.locator('[data-express-toggle]').click();self.page.wait_for_timeout(3200)
        self.assertEqual(self.root.get_attribute('data-phase'),'1')
        self.root.locator('[data-express-toggle]').click();phase=self.root.get_attribute('data-phase');self.page.wait_for_timeout(3200)
        self.assertEqual(self.root.get_attribute('data-phase'),phase)
        self.root.locator('[data-express-restart]').click()
        self.assertEqual(self.root.get_attribute('data-phase'),'0')
        self.assertEqual(self.root.locator('[data-pack-check]:checked').count(),0)
    def test_readable_controls_and_no_overflow_at_all_sizes(self):
        for width,height in [(1440,1000),(768,1024),(1024,768),(375,812)]:
            with self.subTest(width=width):
                self.page.set_viewport_size({'width':width,'height':height})
                self.root.locator('[data-express-step="3"]').click()
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
                sizes=self.root.locator('small,button,label').evaluate_all('(els)=>els.filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize))')
                self.assertGreaterEqual(min(sizes),14)
                self.assertFalse(self.errors)

if __name__=='__main__':unittest.main()
