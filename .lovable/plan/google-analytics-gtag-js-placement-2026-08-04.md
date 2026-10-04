# Google Analytics gtag.js placement

## Current state
The requested Google tag (`G-3WDT28KM50`) is already present in `index.html` inside the `<head>` tag, immediately after the Google Tag Manager block and before `<meta charset>`.

```html
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-3WDT28KM50"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-3WDT28KM50');
</script>
```

## What the plan covers
1. Verify the tag is correctly placed in `<head>` and loads before the app bundle.
2. Confirm there is only one instance of the tag (no duplication).
3. Optionally add a route-change page_view event helper in the React app so SPA navigation is tracked.

## Technical notes
- Keeping the tag in `index.html` is the standard approach for Vite/React SPAs.
- The existing GTM block (`GTM-WDZSLD28KM50` → actually `GTM-WDZSLD8C`) and gtag.js can coexist; both use the same `dataLayer`.
- No code or database changes are required unless we add SPA route tracking.

## Acceptance criteria
- [ ] `index.html` contains the exact gtag snippet requested by the user.
- [ ] No duplicate gtag/GTM snippets exist.
- [ ] (Optional) SPA route changes emit `gtag('event', 'page_view', ...)`.
