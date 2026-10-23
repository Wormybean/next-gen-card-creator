// The add-on's page: the same card maker as the website, with app/backend.ts swapped for
// addon/src/anki/backend.ts when this is bundled (scripts/build-addon.mjs).

import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import "../../app/globals.css";
import { py } from "./anki/bridge";

// Links to other sites (Google AI Studio, readings) open in the normal browser.
document.addEventListener("click", (e) => {
  const link = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || !/^https?:/.test(link.href) || new URL(link.href).origin === location.origin) return;
  e.preventDefault();
  void py("openLink", link.href);
});

createRoot(document.getElementById("root")!).render(<Home />);
