"""Manual operator command only; never imported or run by build/start scripts."""
import getpass
import json
import re
import sys
import urllib.request

WEBHOOK_URL = 'https://cut-culture.vercel.app/api/telegram-webhook'


def main():
    if not sys.stdin.isatty():
        print('Use an interactive trusted terminal for hidden secret input.', file=sys.stderr)
        return 1
    token = getpass.getpass('Bot token (hidden): ').strip()
    secret = getpass.getpass('Webhook secret, same as Vercel (hidden): ').strip()
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', secret):
        print('Invalid token/secret format; nothing sent.', file=sys.stderr)
        return 1
    request = urllib.request.Request(
        'https://api.telegram.org/bot' + token + '/setWebhook',
        data=json.dumps({
            'url': WEBHOOK_URL,
            'secret_token': secret,
            'allowed_updates': ['message'],
            'max_connections': 1,
        }).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        # Do not print exceptions: their URL can contain the bot token.
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        if result.get('ok') is not True:
            print('Telegram did not confirm webhook registration.', file=sys.stderr)
            return 1
    except Exception:
        print('Registration not confirmed. Check Telegram/Vercel configuration; no secret values were printed.', file=sys.stderr)
        return 1
    print('Webhook registered: ' + WEBHOOK_URL)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print('\nRegistration cancelled.', file=sys.stderr)
        sys.exit(1)
