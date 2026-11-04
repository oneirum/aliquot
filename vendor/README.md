# vendor

`deepmerge/` is deepmerge 4.3.1 (MIT, `license.txt`) with one patch: an own `__proto__` key is never copied
into the merged object (GHSA-gcqx-w48m-w2h4, no fixed upstream release). Payload depends on it; the root
`pnpm.overrides` points every copy here. Delete this folder and the override when upstream ships a fix or
Payload drops the dependency.
