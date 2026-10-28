#!/usr/bin/env python3
"""Shows the run events a workflow posts with its "Call an HTTPS endpoint" action.

The workshop workflow sends every run event after workflow.triggered to
http://localhost:4545/agentflow (action type webhook.post, connection: http).
Each request is one event: {"type": "<event>", "run": WorkflowRunSnapshot}.
This prints one block per event and appends the raw body to event-feed.jsonl.

Usage: python3 docs/workshop/event-feed.py [--port 4545] [--log event-feed.jsonl]
Only the standard library; listens on 127.0.0.1 only.
"""
import argparse
import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ICONS = {
    "workflow.triggered": "🤖",
    "workflow.started": "🚀",
    "plan.started": "🧭",
    "plan.completed": "📝",
    "input.needed": "❓",
    "execute.started": "🛠️",
    "execute.completed": "✅",
    "workflow.completed": "🎉",
    "workflow.failed": "⚠️",
}


def describe(event: str, run: dict) -> list[str]:
    source = run.get("source") or {}
    lines = [
        f"{ICONS.get(event, '•')} {event:<20} {source.get('key', '?')}  {source.get('title', '')}",
        f"   run status: {run.get('status')}   run: {run.get('url')}",
    ]
    step = run.get("step") or {}
    if step.get("name"):
        lines.append(f"   step: {step['name']}")
    feature = run.get("feature") or {}
    if feature.get("url"):
        lines.append(f"   source document: {feature.get('title')}  {feature['url']}")
    plan = run.get("plan") or {}
    if plan.get("url"):
        lines.append(f"   plan: {plan['url']}")
    for question in plan.get("openQuestions") or []:
        lines.append(f"     ? {question}")
    for pr in run.get("pullRequests") or []:
        lines.append(f"   pull request: {pr.get('url')}  ({pr.get('repository')})")
    error = run.get("error") or {}
    if error.get("message"):
        lines.append(f"   error: {error.get('code')}: {error['message']}")
    return lines


class Handler(BaseHTTPRequestHandler):
    log_path = "event-feed.jsonl"

    def do_POST(self):  # noqa: N802 (http.server naming)
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(min(length, 2_000_000))
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        event = str(body.get("type") or "?")
        run = body.get("run") if isinstance(body.get("run"), dict) else {}
        stamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] " + "\n".join(describe(event, run)), flush=True)
        with open(self.log_path, "a", encoding="utf-8") as log:
            log.write(json.dumps({"receivedAt": stamp, **body}) + "\n")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *_args):
        return


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=4545)
    parser.add_argument("--log", default="event-feed.jsonl")
    args = parser.parse_args()
    Handler.log_path = args.log
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Listening on http://localhost:{args.port}/agentflow (log: {args.log})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
