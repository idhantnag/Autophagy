# Autophagy Radar

Site URL: https://idhantnag.github.io/Autophagy/

A  literaure radar: a static site that composes
real [PubMed E-utilities](https://www.ncbi.nlm.nih.gov/home/develop/api/) queries in the browser,
so every paper and every summary is **live and never model-invented**.

What makes this one different — shaped to how Prof. Manjithaya asked to use it:

- **One simple screen.** Pick a time window ("brief me on the last 30 days", or a custom range)
  and press one button.
- **Spoken *and* written briefing.** The summary is read aloud with the browser's built-in speech
  synthesis (it auto-selects an Indian-English voice, e.g. *Rishi*). No account, no key, works offline
  once loaded.
- **A proactive assistant.** The *On your radar* cards surface work close to his own techniques —
  "you've dissected mitophagy in neurodegeneration; I noticed these groups have new mitophagy work,
  want a summary?" — one click generates a focused briefing for that thread.
- **Whole-field scope, not just autophagy labs.** The base query nets autophagy papers across *all*
  journals and groups; the themes are facets tuned to his interests (mitophagy, aggrephagy &
  synucleinopathy, pexophagy, xenophagy/infection, unconventional secretion, autophagy in cancer,
  small-molecule modulators, …).
- **Standout papers with PubMed IDs.** Every briefing names the groundbreaking / high-profile papers
  and shows their PMID as a one-click link.

## Optional: a warmer, Claude-written narrative

The tool works fully **without any key**. If you add your own Anthropic API key (⚙ in the header),
Claude writes the narrative over the same live PubMed results — connecting new papers back to your
techniques — while every PMID stays real (Claude only phrases; it never invents papers). It is a
bring-your-own-key feature: the key lives only in your browser and is sent directly to Anthropic.

## Running it

It's a static site — open `index.html` behind any static server, e.g.:

```bash
python3 -m http.server 8777
# then visit http://localhost:8777/Autophagy/
```

## Refreshing the trend cache

The long-view chart and the "last 30 days" radar counts are pre-computed into `data/autophagy.json`
so the page loads instantly. Everything else is live. Refresh the cache any time:

```bash
python3 scripts/fetch_autophagy.py --email you@example.com
```

Add `--api-key <NCBI_KEY>` to go faster. All theme/query definitions live in `data/autophagy.json`,
which the script reads and writes back — a single source of truth shared with the browser.
