# 旅伴帳 網頁版 (tripbook-web)

Mobile-first PWA for iPhone/any browser, sharing the same Firebase project (`triphelper-27b5a`) as the Android app.

- `#/` home · `#/join[/CODE]` companion join · `#/t/{tripId}[/me]` companion 我要買 / 我的花費
- `#/owner` 主帳號 (Google) trip list · `#/o/{tripId}/invite|shop|money`
- `logic.js` is a 1:1 port of `SharedView` / `SplitMath` / `ShoppingText` / `Money`; `node test/logic.test.mjs`
- Expenses, splits and cash are only written by the Android 主帳號 phone; the web never writes `expenses` or trip `members`.
  Buy/unbuy (also for the owner on the web) goes through `inbox`, which the Android phone ingests.
