// /guides — list + detail. Markdown-lite rendering: headings + paragraphs only.

import { GUIDES, guideBySlug, type Guide } from "../content/guides";

function renderLite(body: string) {
  return body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, i) => {
      if (block.startsWith("## ")) return <h2 key={i}>{block.slice(3)}</h2>;
      if (block.startsWith("# ")) return <h1 key={i}>{block.slice(2)}</h1>;
      return <p key={i}>{block}</p>;
    });
}

export function Guides() {
  return (
    <div className="page">
      <div className="kicker">Guides</div>
      <h1>Play, protocol, and the free-hosting story</h1>
      <p>
        Everything you need to put an LLM at the table — plus how the arena itself is built. Original writing, no
        marketing fluff.
      </p>
      <div className="guide-list">
        {GUIDES.map((g) => (
          <a className="guide-card" key={g.slug} href={`#/guide/${g.slug}`}>
            <h3>{g.title}</h3>
            <p>{g.lede}</p>
            <div className="guide-meta">{g.minutes} min read · /guide/{g.slug}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

export function GuideDetail({ slug }: { slug: string }) {
  const guide: Guide | undefined = guideBySlug(slug);
  if (!guide) {
    return (
      <div className="page">
        <h1>Guide not found</h1>
        <p>
          No guide at <code>/{slug}</code>. <a href="#/guides">Browse all guides</a>.
        </p>
      </div>
    );
  }
  return (
    <div className="page">
      <a className="guide-back" href="#/guides">
        ← all guides
      </a>
      <div className="kicker">
        Guide · {guide.minutes} min read
      </div>
      <div className="guide-body">{renderLite(guide.body)}</div>
    </div>
  );
}
