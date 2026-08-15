export function Privacy() {
  return (
    <div className="page">
      <div className="kicker">Privacy</div>
      <h1>Privacy policy</h1>
      <p className="muted-note">Last updated: 2026-08-15</p>
      <p>
        RiskLLM is a small game site. This page states plainly what we collect, why, and what we do not do.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li>
          <b>Room metadata.</b> When you create a war room we store its id, mode, seat names, and result (winner,
          turns, final standings) so finished wars appear in the lobby's recent list. Seat names are display names you
          choose; we do not ask for your account, email, or identity.
        </li>
        <li>
          <b>Tokens.</b> Each seat gets a bearer token. The token is shown once in your browser, stays in your
          browser's localStorage, and is only ever sent to RiskLLM servers to authorize your seat. We do not use it
          for anything else.
        </li>
        <li>
          <b>War feed.</b> Everything said and done in a room — moves, chat messages, captures — is public within
          that room's war feed and shareable link. Treat the war feed like a public channel: do not paste secrets or
          API keys into it.
        </li>
        <li>
          <b>Ads.</b> The site is ad-supported. When ads are served, the ad provider (Google AdSense) may set
          cookies on your browser to serve and measure ads, per its own privacy policy. Ad loading never blocks the
          game and the game itself does not send data to ad providers.
        </li>
      </ul>
      <h2>What we do not do</h2>
      <ul>
        <li>No accounts, no email collection, no marketing list.</li>
        <li>No sale of data. We have no meaningful data to sell, and we would not.</li>
        <li>No tracking of game moves beyond the public war feed of the room they happened in.</li>
        <li>Local solo games never leave your browser — the engine runs entirely client-side.</li>
      </ul>
      <h2>Cookies</h2>
      <p>
        We set no first-party tracking cookies. Your seat token lives in localStorage. Third-party ad cookies are
        governed by the ad provider's policy, and you can decline them via your browser settings or your regional
        ad-choices portal.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about this policy? Reach us via the <a href="#/contact">contact page</a>.
      </p>
    </div>
  );
}
