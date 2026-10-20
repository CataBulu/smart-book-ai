def test_home_shows_greeting_moods_shelf_and_date_stamp(ui):
    assert ui.d.title == "Smart Book AI"
    ui.text_el("What would you like to read next?")
    ui.until(lambda: len(ui.visible(".mood")) == 8, "8 mood chips")  # the home screen fades in
    ui.until(lambda: len(ui.visible(".shelf-book")) == 12, "a shelf of 12 books")
    assert "DATE ISSUED" in ui.find(".stamp").text.upper()


def test_see_all_opens_the_library(ui):
    ui.click("See all", exact=False)
    ui.text_el("Your library")
    ui.until(lambda: len(ui.visible(ui.tid("book-card"))) >= 60, "the whole library")


def test_library_link_sits_at_the_bottom_above_settings(ui):
    library = ui.button("Library", exact=False).rect
    settings = ui.button("Settings").rect
    assert library["y"] < settings["y"] < library["y"] + 90
