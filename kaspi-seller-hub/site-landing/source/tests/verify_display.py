"""Post-fix visual evidence and actual animated state changes."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
OUT=Path('/home/ubuntu/marketflow/artifacts/display-audit/after')
OUT.mkdir(parents=True,exist_ok=True)
report=[]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    for name,width,height in [('desktop',1440,900),('wide',1920,1080),('tablet',768,1024),('tablet-landscape',1024,768),('phone',375,812)]:
        page=b.new_page(viewport={'width':width,'height':height},reduced_motion='no-preference')
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:3000/',wait_until='networkidle')
        page.add_style_tag(content='html{scroll-behavior:auto!important}')
        result={'screen':name,'width':width,'height':height,'demos':[]}
        page.screenshot(path=str(OUT/f'{name}-hero.png'))
        for selector in ['#live-demo','#connection-demo','#picker-demo']:
            root=page.locator(selector)
            page.evaluate('(selector)=>document.querySelector(selector).scrollIntoView({block:"start",behavior:"instant"})',selector)
            page.wait_for_timeout(350)
            before=root.get_attribute('data-phase')
            page.screenshot(path=str(OUT/f'{name}-{selector[1:]}.png'))
            page.wait_for_timeout(3300)
            result['demos'].append({'demo':selector,'changed':root.get_attribute('data-phase')!=before,'running':root.get_attribute('data-running')})
        for label,selector in [('orders','#screens'),('roles','.role-demo'),('calculator','#economy')]:
            page.locator(selector).scroll_into_view_if_needed()
            page.wait_for_timeout(250)
            page.screenshot(path=str(OUT/f'{name}-{label}.png'))
        result['overflow']=page.evaluate('document.documentElement.scrollWidth>innerWidth')
        result['errors']=errors
        result['fontsLocal']=page.evaluate("performance.getEntriesByType('resource').filter(e=>e.initiatorType==='css'&&/\\.ttf/.test(e.name)).every(e=>new URL(e.name).origin===location.origin)")
        report.append(result)
        print(json.dumps(result,ensure_ascii=False),flush=True)
        page.close()
    b.close()
(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
assert all(not r['overflow'] and not r['errors'] and all(d['changed'] and d['running']=='true' for d in r['demos']) for r in report)
