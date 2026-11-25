"""Locale regressions: missing controls, untranslated rerenders, lost user state.

Real app/browser tests, not dictionary mocks or source-text assertions.
"""
import re
import unittest
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/'

class I18nTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = sync_playwright().start()
        cls.browser = cls.p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.p.stop()
    def setUp(self):
        self.context = self.browser.new_context(viewport={'width':1440,'height':900}, reduced_motion='reduce')
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.goto(URL, wait_until='networkidle')
        self.page.add_style_tag(content='html{scroll-behavior:auto!important}')
    def tearDown(self):
        self.context.close()
    def choose(self, lang):
        control = self.page.locator(f'[data-language="{lang}"]')
        self.assertEqual(control.count(), 1, 'Missing language control')
        control.click()
        self.assertEqual(self.page.locator('html').get_attribute('lang'), lang)
    def test_switches_whole_landing_and_restores_russian(self):
        ru = {s:self.page.locator(s).inner_text() for s in ['h1','.hero-lead','#pricing','.pilot-copy','.site-footer']}
        color = self.page.locator('h1 em').evaluate('(e)=>getComputedStyle(e).color')
        self.choose('kk')
        self.assertIn('дүкен', self.page.locator('h1').inner_text().lower())
        self.assertEqual(self.page.locator('[data-language="kk"]').get_attribute('aria-pressed'), 'true')
        for sel, text in ru.items(): self.assertNotEqual(self.page.locator(sel).inner_text(), text, sel)
        self.assertIn('25 000', self.page.locator('#pricing').inner_text())
        self.assertRegex(self.page.title(), '[ӘәҒғҚқҢңӨөҰұҮүІі]')
        self.assertNotIn('Ваше имя', self.page.locator('input[name="name"]').get_attribute('placeholder'))
        self.assertEqual(self.page.locator('h1 em').evaluate('(e)=>getComputedStyle(e).color'), color)
        self.choose('ru')
        for sel, text in ru.items(): self.assertEqual(self.page.locator(sel).inner_text(), text, sel)
        self.assertFalse(self.errors)
    def test_fixed_additional_store_price_is_localized_and_restores_ru(self):
        prices=self.page.locator('#pricing .price')
        russian=[price.text_content() for price in prices.all()]
        self.assertEqual(len(russian),5)
        for amount in ['12 000','20 000','25 000','30 000','5 000']:
            self.assertIn(amount, ' '.join(russian))
        self.assertIn('₸ / мес',russian[2])
        self.choose('kk')
        labels=[' '.join(prices.nth(i).text_content().split()) for i in range(5)]
        self.assertRegex(labels[2],r'25\s+000\s*₸\s*/\s*ай')
        self.assertRegex(labels[4],r'5\s+000\s*₸\s*/\s*ай')
        self.assertTrue(all('бастап' not in label for label in labels))
        self.choose('ru')
        self.assertEqual([price.text_content() for price in prices.all()],russian)
    def test_preference_query_and_denied_storage(self):
        self.choose('kk')
        self.page.reload(wait_until='networkidle')
        self.assertEqual(self.page.locator('html').get_attribute('lang'), 'kk')
        self.page.goto(URL+'?lang=ru', wait_until='networkidle')
        self.assertEqual(self.page.locator('html').get_attribute('lang'), 'ru')
        self.page.goto(URL+'?lang=invalid', wait_until='networkidle')
        self.assertIn(self.page.locator('html').get_attribute('lang'), ['ru','kk'])
        other = self.browser.new_context(reduced_motion='reduce')
        other.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}})")
        page = other.new_page(); failures=[]; page.on('pageerror',lambda e:failures.append(str(e)))
        page.goto(URL+'?lang=kk',wait_until='networkidle')
        self.assertEqual(page.locator('[data-language="ru"]').count(),1)
        self.assertEqual(page.locator('html').get_attribute('lang'),'kk')
        page.locator('[data-language="ru"]').click()
        self.assertEqual(page.locator('html').get_attribute('lang'),'ru')
        self.assertFalse(failures);other.close()
    def test_switch_preserves_forms_calculator_and_express_checks(self):
        self.page.locator('input[name="name"]').fill('Әли')
        self.page.locator('input[name="contact"]').fill('@ali')
        self.page.locator('select[name="volume"]').select_option(index=2)
        self.page.locator('.check-option:has(input[value="Kaspi-2"])').click()
        self.page.locator('.screen-tab[data-screen="orders"]').click()
        self.page.locator('.role-tab[data-role="picker"]').click()
        self.page.locator('#orders-range').evaluate("e=>{e.value=120;e.dispatchEvent(new Event('input',{bubbles:true}))}")
        self.page.locator('[data-express-step="2"]').click()
        self.page.locator('[data-pack-check="0"]').check()
        for lang in ['kk','ru','kk']:
            self.choose(lang)
            self.assertEqual(self.page.locator('input[name="name"]').input_value(),'Әли')
            self.assertEqual(self.page.locator('input[name="contact"]').input_value(),'@ali')
            self.assertEqual(self.page.locator('select[name="volume"]').input_value(),'100–300')
            self.assertTrue(self.page.locator('input[value="Kaspi-2"]').is_checked())
            self.assertIn('active',self.page.locator('.screen-tab[data-screen="orders"]').get_attribute('class'))
            self.assertIn('active',self.page.locator('.role-tab[data-role="picker"]').get_attribute('class'))
            self.assertEqual(self.page.locator('#orders-range').input_value(),'120')
            self.assertEqual(self.page.locator('#express-demo').get_attribute('data-phase'),'2')
            self.assertTrue(self.page.locator('[data-pack-check="0"]').is_checked())
        self.assertIn('240',self.page.locator('#saved-minutes').inner_text())
        self.assertIn('сағ',self.page.locator('#saved-hours').inner_text())
        self.page.locator('#manual-range').evaluate("e=>{e.value=4;e.dispatchEvent(new Event('input',{bubbles:true}))}")
        self.assertIn('300',self.page.locator('#saved-minutes').inner_text())
        self.assertIn('сағ',self.page.locator('#saved-hours').inner_text())
        self.assertIn('ай',self.page.locator('#saved-month').inner_text())
    def test_all_demo_rerenders_and_playback_labels_stay_kazakh(self):
        self.choose('kk')
        for root, prefix, steps in [('#live-demo','demo',6),('#connection-demo','connect',5),('#picker-demo','picker',5),('#express-demo','express',5)]:
            for step in range(steps):
                self.page.locator(f'[{"data-"+prefix+"-step"}="{step}"]').click()
                title = self.page.locator(f'[data-{prefix}-title]').inner_text()
                self.assertRegex(title,'[ӘәҒғҚқҢңӨөҰұҮүІі]',(root,step,title))
                self.assertNotRegex(title,r'\b(Заказ|Сборщик|Откройте|Нажмите|Срочные|Одинаковые|Передайте|Сравнивайте)\b')
            toggle=self.page.locator(f'[data-{prefix}-toggle]')
            toggle.click()
            self.assertNotRegex(toggle.get_attribute('aria-label') or '',r'Воспроизвести|Приостановить|Поставить')
            self.assertNotIn('Пауза',toggle.inner_text())
            toggle.click()
        self.assertFalse(self.errors)
    def test_kazakh_form_feedback_is_honest_and_localized(self):
        self.choose('kk')
        self.page.locator('#pilot-form button[type="submit"]').click()
        msg=self.page.locator('input[name="name"]').evaluate('(e)=>e.validationMessage')
        self.assertRegex(msg,'[ӘәҒғҚқҢңӨөҰұҮүІі]')
        self.page.locator('input[name="name"]').fill('Әли')
        self.page.locator('input[name="contact"]').fill('@ali')
        self.page.locator('.consent input').check()
        self.page.locator('#pilot-form button[type="submit"]').click()
        self.page.wait_for_function("document.querySelector('.toast')?.textContent.includes('Өтінім мәтіні көшірілді')")
        toast=self.page.locator('.toast').inner_text()
        self.assertIn('Өтінім мәтіні көшірілді',toast)
        self.assertIn('чатқа',toast)
        self.assertNotIn('демо',toast.lower())
        self.assertNotIn('заявка записана',toast)
    def test_no_russian_business_copy_in_kazakh_dom_or_labels(self):
        self.choose('kk')
        text=self.page.locator('#app').text_content()
        labels=self.page.locator('#app [aria-label], #app [placeholder]').evaluate_all('es=>es.map(e=>e.getAttribute("aria-label")||e.getAttribute("placeholder")).join(" ")')
        self.assertNotRegex(text+' '+labels,r'(?i)\b(?:магазин(?:а|ов)?|заказ(?:а|ов)?|сборщик(?:а|ов)?|владелец|накладная|отгрузка|воспроизвести|приостановить|подключить)\b')
        self.choose('ru')
        self.assertIn('Подключить',self.page.locator('#app').text_content())
    def test_controls_tabs_and_generated_labels_at_all_sizes(self):
        for width,height in [(320,812),(375,812),(768,1024),(1024,900),(1101,900),(1440,900)]:
            self.page.set_viewport_size({'width':width,'height':height})
            for lang in ['kk','ru']:
                self.choose(lang)
                self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'),width)
                for control in self.page.locator('[data-language]').all():
                    self.assertTrue(control.is_visible())
                    box=control.bounding_box();self.assertGreaterEqual(box['height'],44);self.assertGreaterEqual(box['width'],44)
                for tab in self.page.locator('.screen-tab').all():
                    tab.click();self.assertIn('active',tab.get_attribute('class'))
                for tab in self.page.locator('.role-tab').all():
                    tab.click();self.assertIn('active',tab.get_attribute('class'))
            self.choose('kk')
            content=self.page.locator('.time-visual').evaluate('(e)=>getComputedStyle(e,"::before").content')
            self.assertNotIn('Сейчас',content)

if __name__ == '__main__': unittest.main()
