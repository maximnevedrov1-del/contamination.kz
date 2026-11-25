"""Diagnostic evidence for tiny text and autoplay failure; local only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path('/home/ubuntu/marketflow/artifacts/display-audit')
ROOT.mkdir(parents=True,exist_ok=True)
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    for name,w,h in [('desktop',1440,900),('wide',1920,1080),('tablet',768,1024),('tablet-landscape',1024,768),('phone',375,812)]:
        page=browser.new_page(viewport={'width':w,'height':h},reduced_motion='no-preference')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:3000/',wait_until='networkidle')
        page.add_style_tag(content='html{scroll-behavior:auto!important}')
        data={'screen':name,'width':w,'height':h,'errors':errors,'demos':[]}
        data['smallText']=page.evaluate("""() => Array.from(document.querySelectorAll('small,p,button')).filter(e=>e.getClientRects().length&&e.textContent.trim()).map(e=>({text:e.textContent.trim().slice(0,65),size:parseFloat(getComputedStyle(e).fontSize),selector:e.className})).filter(e=>e.size<14).slice(0,20)""")
        data['overflow']=page.evaluate('document.documentElement.scrollWidth>innerWidth')
        page.screenshot(path=str(ROOT/f'{name}-before-hero.png'))
        for id in ['live-demo','connection-demo','picker-demo']:
            section=page.locator('#'+id)
            page.evaluate('(id)=>document.getElementById(id).scrollIntoView({block:"start",behavior:"instant"})',id)
            page.wait_for_timeout(350)
            before=section.get_attribute('data-phase') or section.get_attribute('data-step')
            page.screenshot(path=str(ROOT/f'{name}-before-{id}.png'))
            page.wait_for_timeout(3300)
            after=section.get_attribute('data-phase') or section.get_attribute('data-step')
            data['demos'].append({'id':id,'before':before,'after':after,'running':section.get_attribute('data-running'),'rect':section.bounding_box()})
        results.append(data)
        print(json.dumps(data,ensure_ascii=False),flush=True)
        page.close()
    browser.close()
(ROOT/'baseline.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
