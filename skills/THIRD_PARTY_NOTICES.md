# Third-party notices — bundled employee Skills

`skills/<id>/SKILL.md` are **verbatim upstream texts**, copied byte-for-byte into this
package so an employee's generic Skills are complete even in a project that never
vendored them. Nothing in them is rewritten. Each Skill's own file is authoritative
if the two ever disagree.

The project-copy-first rule still holds: when the session's workspace contains the
same `sourcePath` (see `src/host/skill-binding.ts`), **the project's file is used and
these bundled copies are not read at all**.

The MIT licence requires the copyright and permission notice to accompany copies, so
each upstream is recorded here with its exact source revision and the copyright line
carried by its `LICENSE`.

---

## 1. DeepSeek Harness (dsh) — MIT

- Upstream: the DeepSeek Harness repository (`@deepseek-ai/dsh-root`), as shipped in the
  `0.2.0-rc.2` checkout; skills under `.agents/skills/`.
- Copyright: `Copyright (c) 2026 DeepSeek` (from that repository's `LICENSE`).
- Licence: MIT.

| Bundled id | Upstream path | sha256 (SKILL.md) |
|---|---|---|
| `pre-push-checks` | `.agents/skills/dsh-pre-push-checks/SKILL.md` | `7091F3061DE122D287E323150073984E71116514F9B69EAB800007599B6B336D` |
| `code-review` | `.agents/skills/dsh-code-review/SKILL.md` | `8A91213A7D97503A6C8431276320C681F17C02374ECC9497C7A30D5E071C85B6` |
| `find-simplifications` | `.agents/skills/dsh-find-simplifications/SKILL.md` | `3CB353D38E08DC221BF90973AF0683870D7D1A7E55C49C2726E3BFC6FFF0D699` |

> Note: dsh itself vendored these into `.agents/skills/` **without** carrying upstream
> `LICENSE` files; the notices below supply what that vendoring omitted.

## 2. `tt-a1i/archify` — MIT

- Upstream: `https://github.com/tt-a1i/archify` @ `72c750bb070d95171dbb2244e5b62b1b7da69c12`
- Copyright: `Copyright (c) 2026 tt-a1i (Archify)` and `Copyright (c) 2025 Cocoon AI`
  (the skill declares `based_on: Cocoon-AI/architecture-diagram-generator (MIT, v1.0)`).
- Licence: MIT.

| Bundled id | sha256 (SKILL.md) |
|---|---|
| `archify` | `10094272D6D1B4AD0F2C2E0880CB646FE4991454A2DC3D854AECB27E7407EE1F` |

## 3. `AaravKashyap12/advise-project-approach` — MIT

- Upstream: `https://github.com/AaravKashyap12/advise-project-approach` @ `abdde261c347f820b40f8105e105ee91c02ffaa4`
- Copyright: `Copyright (c) 2026 Aarav`
- Licence: MIT.

| Bundled id | sha256 (SKILL.md) |
|---|---|
| `advise-project-approach` | `6E595B79431FD11C4C997ECA31566C442B146AC392AA8A33D65425093E5F1F81` |

## 4. `addyosmani/agent-skills` — MIT

- Upstream: `https://github.com/addyosmani/agent-skills` @ `be4e44a9fbc5e8df0beaefadbb28bd22ee61cc39`
- Copyright: `Copyright (c) 2025 Addy Osmani`
- Licence: MIT.

| Bundled id | sha256 (SKILL.md) |
|---|---|
| `api-and-interface-design` | `5DAFD0C44A3AABF11CAE5BCB34F6FCC24DFA5C01BA6E0D3176BCE997F4D68BC8` |
| `documentation-and-adrs` | `87AE44A0C7BB3EEFC2131A9D11CAABCC14E4D8DCB27D66A3A675551EE2CE1671` |
| `frontend-ui-engineering` | `2B74AC4862BE3902EC918DCEAC9366A6FE83B9E003601C0DEAF6BE09C1766ACA` |
| `browser-testing-with-devtools` | `4E3AACD6A380CD25BC6C2D67FDD1C926A9B22535B8A62109ECD33CEFD909E3D9` |

---

## Not bundled on purpose

`repository-conventions` (`AGENTS.md`), `defensive-patterns`
(`docs/defensive-patterns.md`) and `testing-policy` (`docs/testing.md`) are the
**project's own** rules. Shipping another team's conventions as if they were the
project's would be inventing project state, so a missing one degrades **with a
signal** (see `skillGapMessage` in `src/host/skill-binding.ts`) instead of being
silently substituted.

## Licence text

All four upstreams are MIT. The MIT terms are identical across them; the differing
part is the copyright line, recorded above. Reference copy:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
