"""Runs the three required test inputs against assistant.generate_reply() and
records the ACTUAL outputs and pass/fail results.

Usage:   python run_tests.py
Output:  results/test_results_<mode>.json and results/test_results_<mode>.md
         where <mode> is "live" (real AI model) or "demo" (pre-written samples).

PASS/FAIL uses simple keyword checks as a first screen. Read the recorded
output yourself as well - keyword checks cannot judge quality.
"""
import json
import os
import platform
import sys
import time
from datetime import datetime

import assistant as bot

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(HERE, "results")


def check_ml(text):
    t = text.lower()
    notes = []
    ok = True
    for label, cond in [
        ("mentions learning", "learn" in t),
        ("mentions data/examples", "data" in t or "example" in t),
        ("gives an analogy or everyday example", any(w in t for w in ("analogy", "spam", "recommend", "like a child", "for example"))),
        ("is not trivially short (>=300 chars)", len(text) >= 300),
    ]:
        notes.append(f"{'ok' if cond else 'MISSING'}: {label}")
        ok &= cond
    return ok, notes


def check_async(text):
    t = text.lower()
    notes = []
    ok = True
    for label, cond in [
        ("mentions synchronous", "synchronous" in t),
        ("mentions asynchronous", "asynchronous" in t),
        ("mentions Promise/async/await/callback", any(w in t for w in ("promise", "async", "await", "callback"))),
        ("contains a code block", "```" in text),
    ]:
        notes.append(f"{'ok' if cond else 'MISSING'}: {label}")
        ok &= cond
    return ok, notes


def check_vague(text):
    t = text.lower()
    notes = []
    ok = True
    for label, cond in [
        ("asks a clarifying question (contains '?')", "?" in text),
        ("asks which topic / for details", any(w in t for w in ("which", "what would you like", "clarif", "more detail", "specify", "what topic"))),
        ("does NOT invent a topic (no ML/JavaScript lecture)", "machine learning" not in t and "javascript" not in t),
    ]:
        notes.append(f"{'ok' if cond else 'MISSING'}: {label}")
        ok &= cond
    return ok, notes


TESTS = [
    {
        "id": 1,
        "input": "Explain machine learning in simple terms.",
        "expected": "Plain-language explanation of ML as learning patterns from data, with a simple analogy/example. Beginner-friendly.",
        "check": check_ml,
    },
    {
        "id": 2,
        "input": "Explain synchronous vs asynchronous JavaScript.",
        "expected": "Clear contrast between synchronous and asynchronous execution, with a short JavaScript code example (callbacks/Promises/async-await).",
        "check": check_async,
    },
    {
        "id": 3,
        "input": "Explain it.",
        "expected": "Vague input with no context: the assistant should NOT guess a topic; it should ask a short clarifying question.",
        "check": check_vague,
    },
]


def run_extra_checks():
    """Error-handling and input-validation checks (no network needed)."""
    results = []

    def record(name, passed, detail):
        results.append({"name": name, "passed": bool(passed), "detail": detail})

    # Empty input is rejected politely
    try:
        bot.generate_reply([{"role": "user", "content": "   "}])
        record("Empty input rejected", False, "no error raised")
    except bot.AssistantError as exc:
        record("Empty input rejected", True, str(exc))

    # Over-long input is rejected
    try:
        bot.generate_reply([{"role": "user", "content": "x" * (bot.MAX_INPUT_CHARS + 1)}])
        record("Over-long input rejected", False, "no error raised")
    except bot.AssistantError as exc:
        record("Over-long input rejected", True, str(exc))

    # API failures are converted to friendly messages (simulated; no real call)
    class AuthenticationError(Exception):
        status_code = 401

    class RateLimitError(Exception):
        status_code = 429

    class APIConnectionError(Exception):
        pass

    original_call, original_live = bot._call_claude, bot.is_live
    try:
        bot.is_live = lambda: True
        for exc_cls in (AuthenticationError, RateLimitError, APIConnectionError):
            def fake_call(_messages, exc_cls=exc_cls):
                try:
                    raise exc_cls("simulated failure sk-secret-should-not-leak")
                except Exception as exc:
                    raise bot.AssistantError(bot._friendly_error(exc)) from exc

            bot._call_claude = fake_call
            try:
                bot.generate_reply([{"role": "user", "content": "hi"}])
                record(f"Simulated {exc_cls.__name__} handled", False, "no error raised")
            except bot.AssistantError as exc:
                leaked = "sk-secret" in str(exc)
                record(f"Simulated {exc_cls.__name__} handled", not leaked, str(exc))
    finally:
        bot._call_claude, bot.is_live = original_call, original_live

    return results


def main():
    mode = "live" if bot.is_live() else "demo"
    print(f"Running tests in {mode.upper()} mode"
          + (f" (model: {bot.get_model()})" if mode == "live" else " - responses are NOT from an AI model"))

    records = []
    for test in TESTS:
        started = time.time()
        try:
            reply = bot.generate_reply([{"role": "user", "content": test["input"]}])
            output, error, reply_mode = reply.text, None, reply.mode
        except bot.AssistantError as exc:
            output, error, reply_mode = "", str(exc), mode
        elapsed = round(time.time() - started, 2)

        if error:
            passed, notes = False, [f"error: {error}"]
        else:
            passed, notes = test["check"](output)
        records.append({
            "id": test["id"], "input": test["input"], "expected": test["expected"],
            "actual_output": output, "error": error, "response_mode": reply_mode,
            "seconds": elapsed, "passed": passed, "check_notes": notes,
        })
        print(f"[{'PASS' if passed else 'FAIL'}] Test {test['id']}: {test['input']!r} ({elapsed}s)")

    extras = run_extra_checks()
    for item in extras:
        print(f"[{'PASS' if item['passed'] else 'FAIL'}] Extra: {item['name']}")

    meta = {
        "mode": mode,
        "model": bot.get_model() if mode == "live" else None,
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
    }
    os.makedirs(RESULTS_DIR, exist_ok=True)
    with open(os.path.join(RESULTS_DIR, f"test_results_{mode}.json"), "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "tests": records, "extra_checks": extras}, fh, indent=2, ensure_ascii=False)

    lines = [f"# Test results ({mode.upper()} mode)", ""]
    if mode == "demo":
        lines += ["> **DEMO MODE:** no API key was set. The outputs below are pre-written sample",
                  "> responses, NOT generated by an AI model. They verify the application logic only.", ""]
    else:
        lines += [f"> Live run using model `{meta['model']}`.", ""]
    lines += [f"Run at: {meta['run_at']} | Python {meta['python']} | {meta['platform']}", ""]
    for r in records:
        lines += [
            f"## Test {r['id']}: {r['input']}", "",
            f"- **Expected behaviour:** {r['expected']}",
            f"- **Response mode:** {r['response_mode']}",
            f"- **Time:** {r['seconds']} s",
            f"- **Result:** {'PASS' if r['passed'] else 'FAIL'}",
            "- **Checks:** " + "; ".join(r["check_notes"]), "",
            "**Actual output:**", "",
            *["> " + ln for ln in (r["actual_output"] or f"(error) {r['error']}").splitlines()], "",
        ]
    lines += ["## Extra checks (error handling and input validation)", "",
              "| Check | Result | Message shown to the student |", "|---|---|---|"]
    for item in extras:
        lines.append(f"| {item['name']} | {'PASS' if item['passed'] else 'FAIL'} | {item['detail']} |")
    with open(os.path.join(RESULTS_DIR, f"test_results_{mode}.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    all_ok = all(r["passed"] for r in records) and all(e["passed"] for e in extras)
    print("All checks passed." if all_ok else "Some checks FAILED - see results folder.")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
