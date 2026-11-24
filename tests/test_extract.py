import json

from pipeline.extract import Item, load_items, parse_name, year_from_url


def rec(kind, pid, name="ა ქართულად | A qartulad - GEMOVIE.TV", status="ok", slug="a-qartulad-2008", **entity):
    url = f"https://gemovie.tv/{kind}/{pid}/{slug}"
    ent = {"@type": "Movie", "url": url, "name": name, "description": "აღწერა",
           "genre": ["დრამა"], "image": "https://img/x.jpg"}
    ent.update(entity)
    ent = {k: v for k, v in ent.items() if v is not ...}
    return {"key": f"{kind}:{pid}", "type": kind, "id": pid, "url": url, "lastmod": "",
            "status": status, "entity": ent if status == "ok" else None}


def write(tmp_path, records, tail=""):
    p = tmp_path / "pages.jsonl"
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records) + tail, encoding="utf-8")
    return p


def test_parse_name_basic():
    assert parse_name("რკინის კაცი ქართულად | Iron Man qartulad - GEMOVIE.TV") == ("რკინის კაცი", "Iron Man")


def test_parse_name_keeps_parenthesised_original():
    name = "მწვანე გველი ქართულად | Green Snake (白蛇2：青蛇劫起) qartulad - GEMOVIE.TV"
    assert parse_name(name)[1] == "Green Snake (白蛇2：青蛇劫起)"


def test_parse_name_without_separator():
    assert parse_name("Solo Title") == ("Solo Title", "")


def test_parse_name_unescapes_entities():
    assert parse_name("ტომი &amp; ჯერი ქართულად | Tom &amp; Jerry qartulad - GEMOVIE.TV") == ("ტომი & ჯერი", "Tom & Jerry")


def test_parse_name_non_string():
    assert parse_name(None) == ("", "")


def test_year_from_url():
    assert year_from_url("https://gemovie.tv/movie/1894/iron-man-qartulad-2008") == 2008
    assert year_from_url("https://gemovie.tv/movie/1894/iron-man-qartulad") == 0
    assert year_from_url("https://gemovie.tv/movie/1894/iron-man-qartulad-2008/") == 2008
    assert year_from_url("") == 0


def test_item_fields(tmp_path):
    p = write(tmp_path, [rec("movie", 1894, name="რკინის კაცი ქართულად | Iron Man qartulad - GEMOVIE.TV",
                             slug="iron-man-qartulad-2008", description="  ტონი &quot;სტარკი&quot; ...  ",
                             genre=["ფანტასტიკა", "მძაფრსიუჟეტიანი"])])
    (it,) = load_items(p)
    assert it == Item(id=1894, type="movie", title_ka="რკინის კაცი", title_en="Iron Man", year=2008,
                      genres=["ფანტასტიკა", "მძაფრსიუჟეტიანი"], description='ტონი "სტარკი" ...',
                      image="https://img/x.jpg", url="https://gemovie.tv/movie/1894/iron-man-qartulad-2008")


def test_missing_description_and_genre(tmp_path):
    p = write(tmp_path, [rec("movie", 1, description=..., genre=...),
                         rec("movie", 2, description=None, genre="დრამა"),
                         rec("movie", 3, description="   ", genre=["დრამა", "", None, "დრამა", " კომედია "])])
    a, b, c = load_items(p)
    assert (a.description, a.genres) == ("", [])
    assert (b.description, b.genres) == ("", ["დრამა"])
    assert (c.description, c.genres) == ("", ["დრამა", "კომედია"])


def test_skips_unusable_records(tmp_path):
    bad_entity = rec("movie", 5)
    bad_entity["entity"] = None
    no_name = rec("movie", 6, name=...)
    p = write(tmp_path, [rec("movie", 1), rec("movie", 2, status="no_ld"), rec("movie", 3, status="http_404"),
                         rec("movie", 4, status="error"), bad_entity, no_name, rec("serial", 7)])
    assert [(i.type, i.id) for i in load_items(p)] == [("movie", 1), ("serial", 7)]


def test_last_line_wins_for_duplicate_key(tmp_path):
    p = write(tmp_path, [rec("movie", 1, description="ძველი"), rec("movie", 1, description="ახალი")])
    (it,) = load_items(p)
    assert it.description == "ახალი"
    # a later failure replaces an earlier success: the page is gone
    p = write(tmp_path, [rec("movie", 1), rec("movie", 1, status="http_404")])
    assert load_items(p) == []


def test_truncated_last_line_and_junk_are_ignored(tmp_path):
    p = write(tmp_path, [rec("movie", 1), rec("movie", 2)], tail='\n[1, 2]\n"x"\n{"key": "movie:3", "type": "mov')
    assert [i.id for i in load_items(p)] == [1, 2]


def test_sitemap_keys_filter(tmp_path):
    p = write(tmp_path, [rec("movie", 1), rec("movie", 2), rec("serial", 2)])
    keys = tmp_path / "keys.json"
    keys.write_text(json.dumps(["movie:2", "serial:2", "movie:99"]), encoding="utf-8")
    assert [(i.type, i.id) for i in load_items(p, keys)] == [("movie", 2), ("serial", 2)]


def test_sorted_by_type_then_id(tmp_path):
    p = write(tmp_path, [rec("serial", 3), rec("movie", 20), rec("serial", 1), rec("movie", 3)])
    assert [(i.type, i.id) for i in load_items(p)] == [("movie", 3), ("movie", 20), ("serial", 1), ("serial", 3)]


def test_missing_file_gives_empty_list(tmp_path):
    assert load_items(tmp_path / "nope.jsonl") == []


def test_site_wide_blurb_is_not_a_description(tmp_path):
    blurb = ("GEMOVIE | ჯიმუვი - უახლესი ფილმები ქართულად 4K ხარისხში. რეიტინგული სერიალები და ანიმეები "
             "ქართული, ინგლისური და რუსული გახმოვანებით.")
    p = write(tmp_path, [rec("movie", 1, description=blurb), rec("movie", 2, description="GEMOVIE-ზე ნაჩვენები ამბავი")])
    a, b = load_items(p)
    assert a.description == ""
    assert b.description == "GEMOVIE-ზე ნაჩვენები ამბავი"
