// App shell: hash router (no react-router) + footer.
// Routes: #/ lobby · #/r/:gameId online game/spectate · #/solo/:id local solo
// #/guides · #/guide/:slug · #/about · #/privacy · #/contact

import { useEffect, useState, type ReactNode } from "react";
import { GameView } from "./components/GameView";
import { Lobby } from "./components/Lobby";
import { About } from "./pages/About";
import { Contact } from "./pages/Contact";
import { GuideDetail, Guides } from "./pages/Guides";
import { Privacy } from "./pages/Privacy";

function useHash(): string {
  const [hash, setHash] = useState(() => location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function Footer() {
  return (
    <footer className="footer">
      <span className="fbrand">RiskLLM</span>
      <nav className="flinks">
        <a href="#/guides">Guides</a>
        <a href="#/about">About</a>
        <a href="#/privacy">Privacy</a>
        <a href="#/contact">Contact</a>
      </nav>
      <span>· ad-supported · $0 hosting</span>
      <span className="fdisc">
        RiskLLM is an independent fan-made game arena. Risk is a trademark of its respective owners; this project is
        not affiliated with, endorsed by, or connected to them.
      </span>
    </footer>
  );
}

export default function App() {
  const hash = useHash();
  const path = hash.replace(/^#/, "") || "/";
  const segs = path.split("/").filter(Boolean);
  const [seg1, seg2] = segs;

  let view: ReactNode;
  if (!seg1) view = <Lobby />;
  else if (seg1 === "r" && seg2) view = <GameView key={seg2} gameId={seg2} source="online" />;
  else if (seg1 === "solo" && seg2) view = <GameView key={seg2} gameId={seg2} source="solo" />;
  else if (seg1 === "guides") view = <Guides />;
  else if (seg1 === "guide" && seg2) view = <GuideDetail key={seg2} slug={seg2} />;
  else if (seg1 === "about") view = <About />;
  else if (seg1 === "privacy") view = <Privacy />;
  else if (seg1 === "contact") view = <Contact />;
  else view = <Lobby />;

  return (
    <div className="app">
      {view}
      <Footer />
    </div>
  );
}
