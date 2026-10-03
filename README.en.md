# X GeWu

[简体中文](README.md) · **English**

**Clean up old posts. Get your follows in order.**

X GeWu is a Tampermonkey userscript for X / Twitter. Clean up posts by date and quantity, see follow relationships in three colors, and organize your account with less effort.

**v0.3.13 · Tampermonkey · MIT**

[Install the script](https://raw.githubusercontent.com/gegewu26-source/X-GeWu/main/X-GeWu.user.js) · [Download the latest release](https://github.com/gegewu26-source/X-GeWu/releases/latest) · [Follow GeWu for updates](https://x.com/gegewu203)

## Highlights

- **Date-based cleanup**: Select a date range to delete your posts, replies and quotes, or undo your reposts.
- **You control the quantity**: Scanning stops as soon as the candidate limit is reached. Track candidates, pending items, session successes and cumulative successes.
- **Three-color follow relationships**: Blue for mutual follows, green for accounts that only follow you, and red for accounts you follow without a visible follow-back. Colors appear directly on account cards.
- **Convenient follow management**: Scan non-follow-back candidates, open usernames in new tabs to review their profiles, then unfollow from the approved list.
- **Protect important accounts**: Keep the usernames you choose out of the automatic unfollow list.
- **Try a simulation first**: Post cleanup and unfollowing both start in simulation mode. Pause, resume, stop or cancel a follow scan.
- **No API keys or server required**: Works through the webpage, with settings and counters stored locally in your browser.

Colors reflect relationships identifiable on the current page. Mutual-follow history only records states the script has observed; a missing follow-back does not prove a past unfollow.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Click “Install the script” above and confirm installation.
3. Open or refresh X to see the **X GeWu** panel.

When updating, replace the existing script instead of enabling multiple copies.

## Usage

**Clean up posts**: Open your own profile, choose post types, dates and a quantity, then select “计算删除数” to count candidates. Keep Dry Run enabled for a rehearsal, check the scope, then disable simulation and start deletion.

**Manage follows**: Open your own Following list, set protected accounts and a limit, then select “扫描关注”. Review candidate profiles, run a simulation, and confirm the unfollow list. Relationship colors also work on your Followers list.

Actual post deletion cannot be undone. Keep anything you need before proceeding.

## Author and updates

Author: [GeWu · @gegewu203](https://x.com/gegewu203)

The script opens the author’s profile on first use, then at most once every 15 days. Active tasks, login verification and background tabs defer the visit. Click the panel title to check for updates anytime.

## License

[MIT](LICENSE)
