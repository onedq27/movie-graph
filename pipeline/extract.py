"""pages.jsonl (written by scrape.py) -> list of Item.

Every record that cannot yield a usable item (failed fetch, no ld+json, no
name, broken JSON line) is skipped; nothing here raises on bad page data.
"""
import html
import json
import re
from dataclasses import dataclass
from pathlib import Path

TYPES = ("movie", "serial")
_SITE_SUFFIX_RE = re.compile(r"\s*-\s*GEMOVIE\.TV\s*$", re.I)
_KA_SUFFIX_RE = re.compile(r"\s+ქართულად\s*$")
_EN_SUFFIX_RE = re.compile(r"\s+qartulad\s*$", re.I)
_YEAR_RE = re.compile(r"-(\d{4})/?$")
# Pages without a description of their own carry the site-wide meta description
# ("GEMOVIE | ჯიმუვი - უახლესი ფილმები ქართულად 4K ხარისხში. ..."). That is not a
# plot, so it counts as "no description".
_SITE_BLURB_RE = re.compile(r"^\s*GEMOVIE\s*\|", re.I)


@dataclass
class Item:
    id: int
    type: str
    title_ka: str
    title_en: str
    year: int
    genres: list[str]
    description: str
    image: str
    url: str


def _text(value) -> str:
    return html.unescape(value).strip() if isinstance(value, str) else ""


def parse_name(name) -> tuple[str, str]:
    """'რკინის კაცი ქართულად | Iron Man qartulad - GEMOVIE.TV' -> ('რკინის კაცი', 'Iron Man')."""
    name = _SITE_SUFFIX_RE.sub("", _text(name))
    if " | " not in name:
        return name.strip(), ""
    ka, en = name.split(" | ", 1)
    return _KA_SUFFIX_RE.sub("", ka).strip(), _EN_SUFFIX_RE.sub("", en).strip()


def year_from_url(url) -> int:
    m = _YEAR_RE.search(url) if isinstance(url, str) else None
    return int(m.group(1)) if m else 0


def _description(value) -> str:
    text = _text(value)
    return "" if _SITE_BLURB_RE.match(text) else text


def _genres(value) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out = []
    for g in value:
        g = _text(g)
        if g and g not in out:
            out.append(g)
    return out


def _to_item(rec) -> Item | None:
    entity = rec.get("entity")
    if rec.get("status") != "ok" or not isinstance(entity, dict):
        return None
    if rec.get("type") not in TYPES or not isinstance(rec.get("id"), int):
        return None
    title_ka, title_en = parse_name(entity.get("name"))
    if not title_ka and not title_en:
        return None
    url = rec.get("url") or entity.get("url")
    url = url if isinstance(url, str) else ""
    return Item(
        id=rec["id"],
        type=rec["type"],
        title_ka=title_ka or title_en,
        title_en=title_en,
        year=year_from_url(url),
        genres=_genres(entity.get("genre")),
        description=_description(entity.get("description")),
        image=entity["image"].strip() if isinstance(entity.get("image"), str) else "",
        url=url,
    )


def load_items(pages_path: Path, sitemap_keys_path: Path | None = None) -> list[Item]:
    """Read pages.jsonl; the last record for a key wins; sorted by (type, id)."""
    pages_path = Path(pages_path)
    latest = {}
    if pages_path.exists():
        with pages_path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:  # blank, junk, or a last line still being written
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("key"), str):
                    latest[rec["key"]] = rec
    keep = None
    if sitemap_keys_path is not None:
        keep = set(json.loads(Path(sitemap_keys_path).read_text(encoding="utf-8")))
    items = []
    for key, rec in latest.items():
        if keep is not None and key not in keep:
            continue
        item = _to_item(rec)
        if item is not None:
            items.append(item)
    items.sort(key=lambda it: (it.type, it.id))
    return items
