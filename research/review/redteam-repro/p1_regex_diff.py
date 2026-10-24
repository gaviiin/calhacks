"""Python matcher (agents/policy.py) vs the module's JS matcher (compileMemoRegex + RegExp.test)."""
import json, subprocess, time, re
from agents import policy as pol
from agents.policy_learner import GP_REGEX

cases = [
    ("(?i)\\bimola\\b", "Hotel - İmola - race team"),          # Turkish dotted capital I (homoglyph)
    ("(?i)canteen", "Factory CANTEKN"),                       # wrong letter on purpose: no match either side
    ("(?i)kart", "Kart hire - team day"),                       # Kelvin sign K
    ("(?i)silverstone", "Hotel - ſilverstone test"),           # long s
    ("canteen$", "Factory canteen\n"),                              # Python $ matches before trailing newline
    ("^\\d{4} tyres$", "٢٠٢٦ tyres"),           # Arabic-Indic digits: Python \d matches
    ("Grove\\sCatering", "Grove﻿Catering canteen"),            # BOM: JS \s matches, Python \s does not
    ("Grove\\sCatering", "Grove\x1cCatering canteen"),              # FS control: Python \s matches, JS not
    ("\\bcatering\\b", "écatering services"),                  # Unicode \w in Python, ASCII \w in JS
    ("^.$", "\U0001F3CE"),                                          # astral char: 1 code point vs 2 UTF-16 units
    (GP_REGEX, "Hotel - Suzukaサーキット"),     # learner's GP regex, CJK right after the city
    (GP_REGEX, "Hotel - İmola - race team"),
]
js = r"""
const cases = JSON.parse(require('fs').readFileSync(0,'utf8'));
function compileMemoRegex(src){let f='',b=src; if(b.startsWith('(?i)')){f='i';b=b.slice(4);} return new RegExp(b,f);}
console.log(JSON.stringify(cases.map(([p,m])=>{try{return compileMemoRegex(p).test(m)}catch(e){return 'ERR '+e.message}})));
"""
out = subprocess.run(["node", "-e", js], input=json.dumps(cases), capture_output=True, text=True, check=True).stdout
jsres = json.loads(out)
print(f"{'pattern':<28} {'memo':<38} python  module(js)")
for (p, m), j in zip(cases, jsres):
    py = pol.matches({"memo_regex": p}, {"memo": m})
    flag = "  <-- DISAGREE" if py != j else ""
    print(f"{(p if len(p)<28 else 'GP_REGEX'):<28} {ascii(m)[:38]:<38} {str(py):<7} {str(j):<9}{flag}")

# empty-ish patterns
for p in ['{"memo_regex": null}', '{"vendor_id": null, "account_code": null}', '{"max_amount_usd_minor": 5000000.0}']:
    print("pattern", p, "python matches anything:", pol.matches(p, {"memo": "x", "account_code": "1", "amount_usd_minor": 1}),
          "(module: parsePattern accepts, patternMismatches -> [] for null keys; 5000000.0 parses as an integer in JS)")

# catastrophic backtracking: a pattern the learner never writes, but Python and JS both accept
evil = "(?i)(\\w+\\s?)+canteen"
for n in (16, 20, 22):
    memo = "a" * n + "!"
    t = time.time(); re.search(evil, memo); py_t = time.time() - t
    t = time.time()
    subprocess.run(["node", "-e", f"/(\\w+\\s?)+canteen/i.test('{memo}')"], check=True)
    js_t = time.time() - t
    print(f"ReDoS {evil!r} memo len {n+1}: python {py_t:.2f}s node {js_t:.2f}s; parse_pattern ok={bool(pol.parse_pattern({'memo_regex': evil}))}")
