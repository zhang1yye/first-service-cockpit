#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright

import full_remediation_shadow_qa as qa

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / 'firstcare-cloud-local/aph2-r50-home-map-label-20260812-v1.js'
CSS = ROOT / 'firstcare-cloud-local/aph2-r50-home-map-label-20260812-v1.css'
OUT = ROOT / 'docs/qa/frontend-skill-cloud-20260812/r50-shadow'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://www.firstcare.cloud'


def probe(page):
    return page.evaluate("""() => {
      const svg = document.querySelector('svg[aria-label="辽宁、河北、天津、北京区域地图"]')
      const svgBox = svg.getBoundingClientRect()
      const groups = [...svg.querySelectorAll(':scope > g[tabindex="0"]')]
      const overlay = svg.querySelector(':scope > g[data-r50-map-label-overlay="beijing"]')
      const details = groups.map((group, index) => {
        const texts = [...group.querySelectorAll(':scope > text')]
        const name = texts[0]
        const rate = texts[1]
        const nameBox = name.getBoundingClientRect()
        const style = getComputedStyle(name)
        return {
          index,
          name: name.textContent.trim(),
          rate: rate.textContent.trim(),
          ariaLabel: group.getAttribute('aria-label'),
          ariaPressed: group.getAttribute('aria-pressed'),
          layer: group.dataset.r50MapLabelLayer || null,
          nameBox: {
            left: Math.round((nameBox.left - svgBox.left) * 10) / 10,
            top: Math.round((nameBox.top - svgBox.top) * 10) / 10,
            right: Math.round((nameBox.right - svgBox.left) * 10) / 10,
            bottom: Math.round((nameBox.bottom - svgBox.top) * 10) / 10,
          },
          style: {
            fill: style.fill,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            paintOrder: style.paintOrder,
            visibility: style.visibility,
            display: style.display,
          },
        }
      })
      return {
        viewport: {width: innerWidth, height: innerHeight},
        release: document.body.dataset.r50MapLabelRelease || null,
        map: {width: Math.round(svgBox.width), height: Math.round(svgBox.height)},
        groups: details,
        order: details.map(item => item.name),
        overlay: overlay ? {
          isLast: overlay === svg.lastElementChild,
          ariaHidden: overlay.getAttribute('aria-hidden'),
          focusable: overlay.getAttribute('focusable'),
          pointerEvents: overlay.getAttribute('pointer-events'),
          texts: [...overlay.querySelectorAll(':scope > text')].map(text => text.textContent.trim()),
          textStyles: [...overlay.querySelectorAll(':scope > text')].map(text => ({
            fill: getComputedStyle(text).fill,
            stroke: getComputedStyle(text).stroke,
            strokeWidth: getComputedStyle(text).strokeWidth,
          })),
          lineCount: overlay.querySelectorAll(':scope > line').length,
        } : null,
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      }
    }""")


def main():
    token = qa.ephemeral_token()
    results = {}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            for width, height in [(390, 844), (640, 844), (932, 700), (1517, 900), (1864, 1000)]:
                context = browser.new_context(viewport={'width': width, 'height': height})
                context.add_init_script(script=(
                    f"localStorage.setItem('cockpit_token',{json.dumps(token)});"
                    f"localStorage.setItem('token',{json.dumps(token)});"
                    "localStorage.setItem('cockpit_user',JSON.stringify({name:'R50影子验收',role:'admin'}));"
                ))
                page = context.new_page()
                page.route(
                    f'**/{JS.name}',
                    lambda route: route.fulfill(path=str(JS), content_type='application/javascript'),
                )
                console_errors, page_errors, failed_requests = [], [], []
                page.on('console', lambda message: console_errors.append(message.text)
                        if message.type == 'error'
                        and '409 (Conflict)' not in message.text
                        and 'Executing inline script violates' not in message.text else None)
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.on('requestfailed', lambda request: failed_requests.append(request.url)
                        if request.failure != 'net::ERR_ABORTED' else None)
                response = page.goto(BASE + '/', wait_until='domcontentloaded', timeout=30_000)
                map_locator = page.locator('svg[aria-label="辽宁、河北、天津、北京区域地图"]')
                map_locator.wait_for(state='attached', timeout=15_000)
                map_locator.scroll_into_view_if_needed()
                before = map_locator.locator('g[tabindex="0"] > text').all_text_contents()
                page.add_style_tag(path=str(CSS))
                page.add_script_tag(url=f'{BASE}/{JS.name}')
                page.wait_for_function(
                    'selector => Boolean(document.querySelector(selector))',
                    arg='[data-r50-map-label-overlay="beijing"]',
                    timeout=5_000,
                )
                page.wait_for_timeout(150)
                result = probe(page)
                after = map_locator.locator('g[tabindex="0"] > text').all_text_contents()

                assert response and response.status == 200, result
                assert sorted(before) == sorted(after), (before, after)
                assert result['release'] == 'r50-home-map-label-20260812-v1', result
                assert result['order'] == ['北京', '天津', '河北', '辽宁'], result
                beijing_rate = next(item['rate'] for item in result['groups'] if item['name'] == '北京')
                assert result['overlay']['isLast'] is True, result
                assert result['overlay']['ariaHidden'] == 'true', result
                assert result['overlay']['focusable'] == 'false', result
                assert result['overlay']['pointerEvents'] == 'none', result
                assert result['overlay']['texts'] == ['北京', beijing_rate], result
                assert result['overlay']['lineCount'] == 1, result
                assert all(style['stroke'] == 'rgba(245, 246, 250, 0.96)'
                           for style in result['overlay']['textStyles']), result
                assert all(style['strokeWidth'] == '2px'
                           for style in result['overlay']['textStyles']), result
                assert result['overflow'] <= 1, result
                for item in result['groups']:
                    assert item['style']['visibility'] == 'visible', item
                    assert item['style']['display'] != 'none', item
                    assert item['style']['stroke'] == 'rgba(245, 246, 250, 0.96)', item
                    assert item['style']['strokeWidth'] == '2px', item
                    assert item['nameBox']['left'] >= 0 and item['nameBox']['top'] >= 0, item
                    assert item['nameBox']['right'] <= result['map']['width'] + 1, item
                    assert item['nameBox']['bottom'] <= result['map']['height'] + 1, item
                beijing = next(item for item in result['groups'] if item['name'] == '北京')
                assert beijing['layer'] is None, beijing
                assert beijing['rate'].endswith('%'), beijing
                assert beijing_rate == beijing['rate'], beijing

                for region in ('北京', '天津', '河北', '辽宁'):
                    group = map_locator.locator(f'g[aria-label^="{region}"]')
                    group.evaluate("""element => element.dispatchEvent(
                      new MouseEvent('click', {bubbles: true, cancelable: true})
                    )""")
                    assert group.get_attribute('aria-pressed') == 'true', region
                result['selectionInteraction'] = '4/4'
                page.wait_for_timeout(150)
                after_interaction = probe(page)
                assert after_interaction['order'] == ['北京', '天津', '河北', '辽宁'], after_interaction
                assert after_interaction['overlay']['isLast'] is True, after_interaction
                assert after_interaction['overlay']['texts'] == ['北京', beijing_rate], after_interaction
                assert not console_errors and not page_errors and not failed_requests, {
                    'consoleErrors': console_errors,
                    'pageErrors': page_errors,
                    'failedRequests': failed_requests,
                }
                result['status'] = response.status
                page.screenshot(path=str(OUT / f'{width}-home-map.png'), full_page=False)
                results[str(width)] = result
                context.close()
            browser.close()

        result_file = OUT / 'r50-shadow-results.json'
        result_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'viewports': len(results), 'resultFile': str(result_file)}, ensure_ascii=False))
    finally:
        token = ''


if __name__ == '__main__':
    main()
