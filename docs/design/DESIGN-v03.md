# Aliquot v0.3 design: more literature tools

Status: released in v0.3.0 (2026-10-30). Read `DESIGN-v02.md` first ("Research tools"). This file only describes
the four tools v0.3 adds and why these four.

## What a lab gets

An agent could find papers in v0.2 but read only titles and short abstracts. In v0.3 it can:

- search Europe PMC, which covers PubMed, PubMed Central and preprints from bioRxiv, medRxiv and other servers, and
  see which hits are open access;
- read an open-access article's full text, section by section, with its license;
- look up one DOI: Crossref's record, plus whether a legal open copy exists and where (Unpaywall);
- walk the citation graph from one paper, backward (its references) or forward (the works that cite it).

## The tools

| Tool | Reads | Egress | Notes |
|---|---|---|---|
| `europepmc_search` | D0 | www.ebi.ac.uk | `resultType=core` for abstracts; `preprints: true` adds `AND SRC:PPR`; `fullText` is true only when the hit is open access, in Europe PMC and has a PMCID |
| `europepmc_fulltext` | D0 | www.ebi.ac.uk | `fullTextXML` read by `jats.ts`; 24,000 characters a call, whole sections only, and a longer section is split at paragraph breaks into numbered parts; a name matches a section's own title first, then its whole heading path, and brings the section's subsections |
| `doi_lookup` | D0 | api.crossref.org, api.unpaywall.org | Unpaywall is asked only when the lab set a contact email, because it requires one |
| `citation_walk` | D0 | api.openalex.org | references are ranked through one `openalex_id` filter of up to 100 ids; abstracts are rebuilt from `abstract_inverted_index` |

All four are `defineTool` built-ins in `packages/core/src/literature.ts`, with `owner: "core"`. Each follows the
v0.2 rules unchanged: the hosts are `public`, so `ctx.fetch` refuses a query from any conversation above D0, and
nothing is sent; a redirect is followed only to a declared host; every call is in the run record as
`tool.requested` and `tool.completed` or `tool.failed`, with `egress.refused` for a refused query.

An answer that repeating cannot change fails as `invalid-input`, so the agent does not retry it. These are a PMCID
with no open-access text, an unknown DOI, an unknown OpenAlex work, and a section name that matches nothing.
Europe PMC answers 500, not 404, for a PMCID without open-access text. The probe on 2026-10-28 got 500 for three
closed articles and for a made-up id. A 500 can also be a real outage, so on a 404 or 500 the tool asks Europe PMC's
search about that PMCID. If the search says the article is open access, the failure is retryable. Otherwise it is
final. A 400 or 422 from any host is final as well, because the host refused the identifier as malformed.

Every response body is capped at 4 MB before it is parsed. An Unpaywall failure keeps the Crossref record and returns
`openAccess: null` with the status, so one host's trouble does not cost the other's answer.

## JATS

`jats.ts` is a tokenizer over the XML, not a parser, in the style of `atom.ts`. It keeps the article title, the
abstract (not a graphical abstract), the license URL or statement, and each body paragraph under its section's title
path. Tables, figures, formulas and supplementary material are dropped, because their text read inline is noise.
Citation markers stay as the publisher writes them, for example "[1,2]". It never resolves entities beyond the five predefined ones and character references,
and it reads no DTD.

## Why these sources and not others

The scout on 2026-10-28 probed each candidate with no key:

- **alphaXiv** (through OpenResearch's `orx`, whose code is MIT) has keyless full-text and semantic search over
  arXiv. Its Terms of Service limit the service to personal use and forbid commercial use and scraping. A lab
  deployment is not personal use, so it is not built in. It can be added if alphaXiv gives written permission.
- **Semantic Scholar** answered 429 at once without a key. Reliable use needs a key.
- **CORE**'s free tier is non-commercial, and Europe PMC and Unpaywall cover the biomedical open-access case.
- **Zenodo and Dataverse** would find datasets that `run_code` cannot fetch, because the container has no network.
- **PDF reading** would put a PDF parser in core. Europe PMC's JATS gives clean text for open-access biomedical
  papers without one.

OpenAlex now meters keyless use by cost: about $0.10 a day of free credit, shared by every caller on the same IP
address. A list call costs $0.0001, so this is about 1,000 searches or walks a day. A lab that needs more can get a
free key from OpenAlex. Aliquot does not send one yet.
