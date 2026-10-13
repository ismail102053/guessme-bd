#!/usr/bin/env python3
"""
ঐচ্ছিক ব্রাউজার E2E টেস্ট (Playwright, Chromium)।
চালানো:  pip install playwright && playwright install chromium && python3 tests/e2e/e2e_flow.py
সার্ভার নিজেই চালু হয় (আলাদা অস্থায়ী SQLite ফাইলে), শেষে বন্ধ হয়।
স্ক্রিনশট যায় $E2E_SHOTS (ডিফল্ট: ./e2e-shots) ফোল্ডারে।
"""
import os, re, subprocess, sys, tempfile, time, urllib.request, shutil
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = os.environ.get('E2E_SHOTS', os.path.join(ROOT, 'e2e-shots'))
os.makedirs(SHOTS, exist_ok=True)
PORT = int(os.environ.get('E2E_PORT', '3411'))
BASE = f'http://127.0.0.1:{PORT}'
TMP = tempfile.mkdtemp(prefix='gm-e2e-')
DB = os.path.join(TMP, 'e2e.db')
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('  ✅ ' if cond else '  ❌ ') + name + (f'  [{extra}]' if extra and not cond else ''))

def start_server():
    env = dict(os.environ, NODE_ENV='development', PORT=str(PORT), HOST='127.0.0.1', SQLITE_PATH=DB,
               APP_SECRET='e2e-secret-e2e-secret-e2e-secret-1234', LOG_SILENT='true',
               PUBLIC_BASE_URL=BASE, RATE_LIMIT_CREATE_PER_HOUR='100', MAX_QUIZZES_PER_IP_PER_DAY='100')
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + '/api/health', timeout=1).read(); return p
        except Exception:
            time.sleep(0.25)
    p.kill(); raise RuntimeError('সার্ভার চালু হয়নি')

def stop_server(p):
    p.terminate()
    try: p.wait(5)
    except Exception: p.kill()

server = start_server()
problems = []   # কনসোল ত্রুটি / CSP লঙ্ঘন
seen_urls = []  # সার্ভারে যাওয়া সব অনুরোধের URL

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        def new_ctx(**kw):
            ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='bn-BD', **kw)
            return ctx
        def watch(page, who):
            expected_http = re.compile(r'Failed to load resource: the server responded with a status of (403|404|422)\b')
            page.on('console', lambda m: problems.append(f'{who}: console.{m.type}: {m.text}')
                    if m.type in ('error', 'warning') and not expected_http.search(m.text) else None)
            page.on('pageerror', lambda e: problems.append(f'{who}: pageerror: {e}'))
            page.on('request', lambda r: seen_urls.append(r.url))

        # ---------- ১. নির্মাতা: ল্যান্ডিং → তৈরি ----------
        print('১. নির্মাতার ফ্লো')
        owner_ctx = new_ctx(permissions=['clipboard-read', 'clipboard-write'])
        owner = owner_ctx.new_page(); watch(owner, 'owner')
        owner.goto(BASE + '/')
        check('ল্যান্ডিং পেজ লোড (শিরোনাম আছে)', owner.locator('h1').inner_text().strip() != '')
        check('ল্যান্ডিংয়ে "আমার কুইজ" লুকানো (প্রথমবার)', owner.locator('#my-quizzes').is_hidden())
        owner.screenshot(path=f'{SHOTS}/01-landing-mobile.png', full_page=True)
        no_hscroll = owner.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        check('ল্যান্ডিংয়ে অনুভূমিক স্ক্রল নেই (মোবাইল)', no_hscroll)

        owner.goto(BASE + '/create')
        owner.wait_for_selector('form')
        # খালি জমা → ক্লায়েন্ট-সাইড ত্রুটি
        owner.click('#submit-btn')
        owner.wait_for_selector('.error-text')
        check('খালি ফর্মে ত্রুটি বার্তা দেখায়', owner.locator('.error-text').count() >= 4)
        check('ত্রুটির ব্যানার role=alert', owner.locator('#form-banner[role=alert]').count() == 1)
        owner.screenshot(path=f'{SHOTS}/02-create-errors.png', full_page=True)

        owner.fill('[data-field="creatorName"]', 'রাফি')
        owner.fill('[data-field="title"]', 'আমাকে কতটা চেনো?')
        qs = [
            ('আমার প্রিয় খাবার কী?', ['বিরিয়ানি', 'খিচুড়ি', 'ভর্তা-ভাত'], 1),
            ('আমার প্রিয় ঋতু কোনটি?', ['গ্রীষ্ম', 'বর্ষা', 'শীত'], 1),
            ('আমি কোন খেলা ভালোবাসি?', ['ক্রিকেট', 'ফুটবল', 'ব্যাডমিন্টন'], 0),
        ]
        for qi, (text, opts, correct) in enumerate(qs):
            owner.fill(f'[data-field="questions.{qi}.text"]', text)
            for oi, o in enumerate(opts):
                owner.fill(f'[data-field="questions.{qi}.options.{oi}"]', o)
            owner.locator(f'input[name="correct-{qi}"]').nth(correct).check()
        # ফাঁকা অপশন বাদ + একটি ইচ্ছাকৃত লিংক-ত্রুটি দিয়ে সার্ভার-সাইড ত্রুটি ম্যাপিং যাচাই
        owner.fill('[data-field="questions.0.options.2"]', 'দেখো www.spam.com')
        owner.click('#submit-btn')
        owner.wait_for_selector('.error-text')
        check('সার্ভারের ভ্যালিডেশন ত্রুটি ফর্মে দেখায় (লিংক নিষিদ্ধ)', 'লিংক' in owner.locator('.error-text').first.inner_text())
        owner.fill('[data-field="questions.0.options.2"]', 'ভর্তা-ভাত')
        owner.screenshot(path=f'{SHOTS}/03-create-filled.png', full_page=True)
        owner.click('#submit-btn')
        owner.wait_for_selector('.copy-box')
        inputs = owner.locator('.copy-box input')
        public_url = inputs.nth(0).input_value()
        manage_url = inputs.nth(1).input_value()
        quiz_id = re.search(r'/q/([a-z0-9]{10})$', public_url).group(1)
        token = manage_url.split('#', 1)[1]
        check('পাবলিক লিংক ফরম্যাট ঠিক', re.fullmatch(rf'{re.escape(BASE)}/q/[a-z0-9]{{10}}', public_url))
        check('পাবলিক লিংকে ওনার টোকেন নেই', token not in public_url)
        check('গোপন লিংকে টোকেন # ফ্র্যাগমেন্টে', re.fullmatch(rf'{re.escape(BASE)}/manage/{quiz_id}#[A-Za-z0-9_-]{{43}}', manage_url))
        fb = owner.locator('a.btn.fb').first.get_attribute('href')
        check('Facebook শেয়ার লিংক সঠিক', fb == 'https://www.facebook.com/sharer/sharer.php?u=' + quote(public_url, safe=''), fb)
        check('Facebook লিংকে rel=noopener', 'noopener' in (owner.locator('a.btn.fb').first.get_attribute('rel') or ''))
        owner.locator('.copy-box button').first.click()
        clip = owner.evaluate('navigator.clipboard.readText()')
        check('লিংক কপি বোতাম ক্লিপবোর্ডে কপি করে', clip == public_url, clip)
        check('FB শেয়ার URL-এ গোপন টোকেন নেই', token not in fb)
        owner.screenshot(path=f'{SHOTS}/04-create-success.png', full_page=True)

        # ---------- ২. বন্ধু: লগইন ছাড়া খেলা ----------
        print('২. বন্ধুর ফ্লো (নতুন ব্রাউজার, কোনো লগইন/স্টোরেজ নেই)')
        friend_ctx = new_ctx()
        friend = friend_ctx.new_page(); watch(friend, 'friend')
        friend.goto(public_url)
        friend.wait_for_selector('#player-name')
        check('কুইজ ইন্ট্রো দেখায় (নির্মাতার নাম আছে)', 'রাফি' in friend.locator('h1').inner_text())
        friend.screenshot(path=f'{SHOTS}/05-quiz-intro.png', full_page=True)
        friend.click('button[type=submit]')
        check('নাম ছাড়া শুরু করা যায় না', friend.locator('.error-text:visible').count() == 1)
        friend.fill('#player-name', 'সুমি')
        friend.click('button[type=submit]')
        friend.wait_for_selector('.option')
        check('প্রথম প্রশ্ন দেখায়', 'আমার প্রিয় খাবার' in friend.locator('.q-text').inner_text())
        friend.screenshot(path=f'{SHOTS}/06-quiz-question.png', full_page=True)
        # উত্তর: ১ম সঠিক(1), ২য় ভুল(0), ৩য় সঠিক(0) → ২/৩
        friend.locator('.option').nth(1).click()
        expect(friend.locator('.q-text')).to_contain_text('ঋতু')
        friend.locator('.option').nth(0).click()
        expect(friend.locator('.q-text')).to_contain_text('খেলা')
        check('শেষ প্রশ্নের আগে জমা বোতাম বন্ধ', friend.locator('#submit-btn').is_disabled())
        friend.locator('.option').nth(0).click()
        check('সব উত্তর দিলে জমা বোতাম চালু', friend.locator('#submit-btn').is_enabled())
        friend.wait_for_timeout(2300)  # বট-গতি সুরক্ষার ন্যূনতম সময় (৭০০ms × ৩)
        friend.click('#submit-btn')
        friend.wait_for_selector('.score-num')
        score_text = friend.locator('.score-num').inner_text()
        check('স্কোর ২/৩ (বাংলা অঙ্কে) দেখায়', '২' in score_text and '৩' in score_text, score_text)
        check('রিভিউতে সঠিক উত্তর দেখায়', 'বর্ষা' in friend.locator('.review').inner_text())
        result_url = friend.locator('a.btn.fb').first.get_attribute('href')
        m = re.search(r'u=(.+)$', result_url)
        from urllib.parse import unquote
        shared_result = unquote(m.group(1))
        check('রেজাল্ট শেয়ার লিংক /r/ পাথে', '/r/' in shared_result, shared_result)
        friend.screenshot(path=f'{SHOTS}/07-quiz-result.png', full_page=True)

        # রেজাল্ট পেজ (যে কেউ খুলতে পারে)
        third_ctx = new_ctx(); third = third_ctx.new_page(); watch(third, 'third')
        third.goto(shared_result)
        third.wait_for_selector('.score-num')
        check('শেয়ার করা রেজাল্ট পেজে নাম ও স্কোর', 'সুমি' in third.locator('body').inner_text())
        check('রেজাল্ট পেজে উত্তরের বিস্তারিত নেই', 'বর্ষা' not in third.locator('body').inner_text())
        check('রেজাল্ট পেজে "তুমিও খেলো" লিংক', third.locator(f'a[href="/q/{quiz_id}"]').count() == 1)
        third.screenshot(path=f'{SHOTS}/08-result-page.png', full_page=True)

        # দ্বিতীয় বন্ধু (সবগুলো সঠিক) → পারফেক্ট
        f2_ctx = new_ctx(); f2 = f2_ctx.new_page(); watch(f2, 'friend2')
        f2.goto(public_url); f2.wait_for_selector('#player-name'); f2.fill('#player-name', 'তানভীর'); f2.click('button[type=submit]')
        f2.wait_for_selector('.option')
        for idx, expect_q in [(1, 'ঋতু'), (1, 'খেলা'), (0, None)]:
            f2.locator('.option').nth(idx).click()
            if expect_q: expect(f2.locator('.q-text')).to_contain_text(expect_q)
        f2.wait_for_timeout(2300)
        f2.click('#submit-btn'); f2.wait_for_selector('.score-num')
        check('দ্বিতীয় বন্ধুর পারফেক্ট স্কোর (৩/৩)', f2.locator('.score-num').inner_text().strip().startswith('৩'))

        # ---------- ৩. ওনার ড্যাশবোর্ড ----------
        print('৩. ড্যাশবোর্ড (প্রাইভেট)')
        owner.goto(manage_url)
        owner.wait_for_selector('.stats')
        stats = owner.locator('.stat b').all_inner_texts()
        check('ড্যাশবোর্ডে "২ জন খেলেছে"', stats[0] == '২', str(stats))
        check('গড় স্কোর ৮৩% (৩+২ / ৬)', stats[1] == '৮৩%', str(stats))
        check('পারফেক্ট ১ জন', stats[2] == '১', str(stats))
        board = owner.locator('.board-row').all_inner_texts()
        check('লিডারবোর্ডে সবার আগে তানভীর (৩/৩)', 'তানভীর' in board[0] and 'সুমি' in board[1], str(board))
        owner.locator('details.attempt summary').nth(1).click()
        check('নামের উপর ক্লিকে প্রতিটি উত্তর দেখায় (ভুল সহ)', '❌' in owner.locator('details.attempt[open]').inner_text())
        owner.screenshot(path=f'{SHOTS}/09-dashboard-mobile.png', full_page=True)
        check('ড্যাশবোর্ডে প্রশ্নভিত্তিক সারসংক্ষেপ', owner.locator('.bar-row').count() >= 9)

        # টোকেন ছাড়া/ভুল টোকেনে — আলাদা ব্রাউজার
        stranger_ctx = new_ctx(); stranger = stranger_ctx.new_page(); watch(stranger, 'stranger')
        stranger.goto(f'{BASE}/manage/{quiz_id}')
        stranger.wait_for_selector('input[aria-label="গোপন লিংক"]')
        check('টোকেন ছাড়া ড্যাশবোর্ডে প্রবেশ নেই (পেস্ট-ফর্ম দেখায়)', stranger.locator('.stats').count() == 0)
        stranger.goto(f'{BASE}/manage/{quiz_id}#' + 'A' * 43)
        stranger.wait_for_selector('.error-text')
        check('ভুল টোকেনে বাংলা ত্রুটি, ডেটা নেই', stranger.locator('.stats').count() == 0 and 'সঠিক নয়' in stranger.locator('.error-text').inner_text())
        stranger.screenshot(path=f'{SHOTS}/10-dashboard-denied.png')

        # ---------- ৪. বন্ধ করা ----------
        print('৪. কুইজ বন্ধ করা')
        owner.get_by_role('button', name=re.compile('কুইজ বন্ধ করো')).click()
        owner.wait_for_selector('.banner.warn')
        f2.goto(public_url); f2.wait_for_selector('.banner.warn')
        check('বন্ধ কুইজে বন্ধুর জন্য "বন্ধ" বার্তা, শুরু বোতাম নেই', f2.locator('button[type=submit]').count() == 0)
        owner.get_by_role('button', name=re.compile('আবার চালু করো')).click()
        expect(owner.locator('.banner.warn')).to_have_count(0)

        # ---------- ৫. ওনারের হোম "আমার কুইজ" ----------
        owner.goto(BASE + '/')
        owner.wait_for_selector('#my-quizzes:not([hidden])')
        check('ওনারের হোমে "আমার কুইজ" তালিকা', owner.locator('#my-list a').count() == 1)

        # ---------- ৬. সার্ভার রিস্টার্ট → ডেটা স্থায়ী? ----------
        print('৫. স্থায়িত্ব: সার্ভার রিস্টার্ট')
        stop_server(server); server = start_server()
        owner.goto(manage_url); owner.wait_for_selector('.stats')
        check('রিস্টার্টের পর ডেটা অক্ষত (২ জন)', owner.locator('.stat b').first.inner_text() == '২')
        friend.goto(shared_result); friend.wait_for_selector('.score-num')
        check('রিস্টার্টের পর শেয়ার করা রেজাল্ট খোলে', 'সুমি' in friend.locator('body').inner_text())

        # ---------- ৭. মুছে ফেলা ----------
        owner.locator('details.attempt summary').first.click()
        owner.once('dialog', lambda d: d.accept())
        owner.get_by_role('button', name=re.compile('এই উত্তরটি মুছো')).first.click()
        expect(owner.locator('.board-row')).to_have_count(1)
        check('একটি উত্তর মোছা যায়', True)
        owner.once('dialog', lambda d: d.accept())
        owner.get_by_role('button', name=re.compile('পুরো কুইজ মুছে ফেলো')).click()
        owner.wait_for_selector('text=মুছে ফেলা হয়েছে')
        r = third.goto(public_url)
        check('মোছা কুইজের পাবলিক লিংকে ৪০৪ পেজ', r.status == 404)
        third.screenshot(path=f'{SHOTS}/11-404.png')

        # ---------- ৮. ডেস্কটপ ভিউ ----------
        desk = browser.new_context(viewport={'width': 1280, 'height': 800}, locale='bn-BD').new_page()
        desk.goto(BASE + '/'); desk.screenshot(path=f'{SHOTS}/12-landing-desktop.png')

        # ---------- সামগ্রিক নিরাপত্তা চেক ----------
        print('৬. নিরাপত্তা-সম্পর্কিত পর্যবেক্ষণ')
        check('গোপন টোকেন কখনো কোনো URL-এ সার্ভারে যায়নি (path/query)', not any(token in u for u in seen_urls))
        check('কনসোলে কোনো ত্রুটি/সতর্কতা/CSP-লঙ্ঘন নেই', not problems, '; '.join(problems[:5]))
        browser.close()
finally:
    stop_server(server)
    shutil.rmtree(TMP, ignore_errors=True)

failed = [r for r in results if not r[1]]
print(f'\nফলাফল: {len(results) - len(failed)}/{len(results)} পাস')
if problems: print('কনসোল সমস্যা:', *problems, sep='\n  ')
sys.exit(1 if failed else 0)
