"""Real-browser regressions for the compact pilot journey.

Catch duplicate/misordered journey groups, a CTA landing above an inaccessible
form, ambiguous store-count selection and clipped mobile form controls.
"""
import unittest
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/'

class LandingRefactorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = sync_playwright().start()
        cls.browser = cls.p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.p.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width':375,'height':812}, reduced_motion='reduce')
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(URL, wait_until='networkidle')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')

    def tearDown(self):
        self.context.close()

    def test_journey_is_grouped_in_requested_order_with_working_anchors(self):
        ids = self.page.locator('main > section').evaluate_all('es=>es.map(e=>e.id)')
        self.assertEqual(ids, ['hero','process','assembly','economy','connection-demo','install','pricing','pilot'])
        for selector in ['#live-demo','#screens','.role-demo','#express-demo','#picker-demo']:
            self.assertEqual(self.page.locator(selector).count(), 1, selector)
        for href in self.page.locator('.main-nav a').evaluate_all('es=>es.map(e=>e.getAttribute("href"))'):
            self.assertEqual(self.page.locator(href).count(), 1, href)
        self.assertFalse(self.errors)

    def test_primary_actions_land_on_install_section(self):
        for selector in ['.hero-actions a[data-sp-install]','#pricing .price-card a[data-sp-install]']:
            for action in self.page.locator(selector).all():
                action.click()
                self.assertTrue(self.page.url.endswith('#install'))
                self.assertTrue(self.page.locator('#install').is_visible())
        self.page.locator('.hero-actions a[href="#live-demo"]').click()
        self.assertTrue(self.page.url.endswith('#live-demo'))
        self.assertGreaterEqual(self.page.locator('#live-demo').bounding_box()['y'], -1)

    def test_new_conversion_offer_and_pricing_are_present_in_both_languages(self):
        self.assertEqual(self.page.locator('.hero-actions a[data-sp-install]').first.inner_text().strip(), 'Установить бесплатно')
        self.assertIn('14 дней бесплатно, до 3 магазинов', self.page.locator('.hero-barrier').inner_text())
        self.assertEqual(self.page.locator('.benefit-card').count(), 3)
        self.assertEqual(self.page.locator('#comparison').count(), 1)
        self.assertEqual(self.page.locator('#pricing .price-card').count(), 5)
        self.assertIn('12 000', self.page.locator('#pricing').inner_text())
        self.assertIn('20 000', self.page.locator('#pricing').inner_text())
        self.assertIn('25 000', self.page.locator('#pricing').inner_text())
        self.assertIn('30 000', self.page.locator('#pricing').inner_text())
        self.assertIn('Начать 14 дней бесплатно', self.page.locator('#pricing').inner_text())
        self.page.locator('[data-language="kk"]').click()
        self.assertIn('14 күн', self.page.locator('.hero-barrier').inner_text())
        self.assertIn('14 күн тегін', self.page.locator('#pricing').inner_text())
        self.page.set_viewport_size({'width':1024,'height':812})
        self.assertIn('Бұлтты сервистер', self.page.locator('#comparison').inner_text())

    def test_hero_sentences_are_separate_and_localized(self):
        self.assertEqual(self.page.locator('.hero-title-line').inner_text(), '3 Kaspi - магазина.')
        self.assertEqual(self.page.locator('.hero h1 em').inner_text(), '1 рабочее окно.')
        self.page.locator('[data-language="kk"]').click()
        self.assertEqual(self.page.locator('.hero-title-line').inner_text(), '3 Kaspi дүкені.')
        self.assertEqual(self.page.locator('.hero h1 em').inner_text(), '1 жұмыс терезесі.')

    def test_install_flow_has_safe_fallback_and_mobile_instructions(self):
        self.assertEqual(self.page.locator('meta[name="sp-extension-id"]').get_attribute('content'), '')
        self.assertEqual(self.page.locator('meta[name="sp-store-url"]').get_attribute('content'), '')
        self.assertEqual(self.page.locator('#install').count(), 1)
        install_links = self.page.locator('[data-sp-install]')
        self.assertGreaterEqual(install_links.count(), 8)
        for link in install_links.all():
            self.assertEqual(link.get_attribute('href'), '#install')
            self.assertTrue(link.get_attribute('data-open-label'))
        self.page.locator('.hero-actions a[data-sp-install]').click()
        self.assertTrue(self.page.url.endswith('#install'))
        self.page.locator('[data-language="kk"]').click()
        self.assertIn('Қалай орнатуға болады', self.page.locator('#install').inner_text())

    def test_application_form_has_telegram_message_and_mailto_fallback(self):
        self.assertNotIn('деморежиме', self.page.locator('#pilot-form').inner_text())
        self.assertIn('Отправить в Telegram', self.page.locator('#pilot-form').inner_text())
        self.assertEqual(self.page.locator('#pilot-form a[href^="mailto:"]').count(), 1)

    def test_copy_link_includes_valid_referral_code_and_kazakh_feedback(self):
        self.page.evaluate("localStorage.setItem('sp_ref_code', 'SP-ABC123')")
        self.page.evaluate("""() => {
            navigator.clipboard.writeText = async (value) => { window.__copiedInstallLink = value; };
        }""")
        self.page.locator('[data-language="kk"]').click()
        self.page.locator('[data-copy-install-link]').click()
        self.page.wait_for_function("window.__copiedInstallLink === 'https://saudapulse.kz/?ref=SP-ABC123'")
        self.assertEqual(self.page.locator('[data-copy-install-link]').inner_text(), 'Сілтеме көшірілді')

    def test_submit_keeps_fields_until_retry_and_shows_blocked_telegram_fallback(self):
        self.page.evaluate("window.open = () => null")
        self.page.locator('[data-language="kk"]').click()
        self.page.locator('input[name="name"]').fill('Әли')
        self.page.locator('input[name="contact"]').fill('@ali')
        self.page.locator('.consent input').check()
        self.page.locator('#pilot-form button[type="submit"]').click()
        self.page.wait_for_function("document.querySelector('.toast')?.classList.contains('show')")
        self.assertEqual(self.page.locator('input[name="name"]').input_value(), 'Әли')
        self.assertEqual(self.page.locator('input[name="contact"]').input_value(), '@ali')
        self.assertTrue(self.page.locator('[data-new-application]').is_visible())
        self.assertTrue(self.page.locator('[data-telegram-fallback]').is_visible())
        self.assertEqual(self.page.locator('[data-telegram-fallback]').get_attribute('href'), 'https://t.me/SaudaPulse')
        self.assertIn('Өтінім мәтіні көшірілді', self.page.locator('.toast').inner_text())
        self.page.locator('[data-new-application]').click()
        self.assertEqual(self.page.locator('input[name="name"]').input_value(), '')
        self.assertEqual(self.page.locator('input[name="contact"]').input_value(), '')

    def test_four_plus_store_choice_is_exclusive_and_survives_language_switch(self):
        options = self.page.locator('#pilot-form input[name="market"]')
        self.assertEqual(options.count(),4)
        for value in ['Kaspi-2','Kaspi-4plus','Kaspi-1','Kaspi-4plus']:
            self.page.locator(f'.check-option:has(input[value="{value}"])').click()
            self.assertEqual(self.page.locator('input[name="market"]:checked').count(),1)
            self.assertTrue(self.page.locator(f'input[value="{value}"]').is_checked())
        self.page.locator('input[name="name"]').fill('Әли')
        for lang in ['kk','ru']:
            self.page.locator(f'[data-language="{lang}"]').click()
            self.assertTrue(self.page.locator('input[value="Kaspi-4plus"]').is_checked())
            self.assertEqual(self.page.locator('input[name="name"]').input_value(),'Әли')
        payload = self.page.locator('#pilot-form').evaluate('f=>new FormData(f).getAll("market")')
        self.assertEqual(payload,['Kaspi-4plus'])

    def test_mobile_controls_do_not_clip_or_overlap_in_either_language(self):
        for width in [360,375,390,414]:
            self.page.set_viewport_size({'width':width,'height':812})
            for lang in ['ru','kk']:
                self.page.locator(f'[data-language="{lang}"]').click()
                self.page.evaluate('document.fonts.ready')
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
                for selector in ['.hero-actions a','.check-option span','.submit-button']:
                    boxes = self.page.locator(selector).evaluate_all('es=>es.map(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,cw:e.clientWidth,sw:e.scrollWidth}))')
                    for box in boxes:
                        self.assertGreaterEqual(box['h'],44,(width,lang,selector))
                        self.assertGreaterEqual(box['x'],-1,(width,lang,selector))
                        self.assertLessEqual(box['x']+box['w'],width+1,(width,lang,selector))
                        self.assertLessEqual(box['sw'],box['cw']+2,(width,lang,selector))
                    for i,a in enumerate(boxes):
                        for b in boxes[i+1:]:
                            overlap = min(a['x']+a['w'],b['x']+b['w'])-max(a['x'],b['x'])>1 and min(a['y']+a['h'],b['y']+b['h'])-max(a['y'],b['y'])>1
                            self.assertFalse(overlap,(width,lang,selector))
                foot = self.page.locator('.form-footnote').bounding_box()
                submit = self.page.locator('.submit-button').bounding_box()
                self.assertGreaterEqual(foot['y'],submit['y']+submit['height']+8)
                self.assertFalse(self.errors)

if __name__ == '__main__':
    unittest.main()
