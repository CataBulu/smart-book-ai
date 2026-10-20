import base64
import re

from selenium.webdriver.common.keys import Keys

from conftest import RUN, api

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def add_book(title: str, **extra) -> dict:
    return api("POST", "/books", {"title": title, "author": "Test Writer", "description": "A book a test added.", **extra})


def test_paint_a_cover_from_the_book_drawer(ui):
    drawer = ui.open_book("Walden")
    ui.click("Paint a", exact=False, root=drawer)  # "Paint a cover", or "Paint a new cover" on a second run
    ui.toast("New cover painted for “Walden”")
    ui.until(lambda: "/api/media/covers/" in ui.find('img[alt="Cover of Walden"]', drawer).get_attribute("src"),
             "the painted cover")


def test_page_count_and_your_own_cover_from_a_picture(ui, files):
    drawer = ui.open_book("Pride and Prejudice")
    assert re.search(r"Contains about \d+ pages", ui.find(".drawer-meta", drawer).text)
    ui.press(Keys.ESCAPE)

    drawer = ui.open_book("Stoner")
    assert "No pages yet" in ui.find(".drawer-meta", drawer).text
    ui.button("Add your own cover from files", root=drawer)
    ui.find(ui.tid("cover-input"), drawer, visible=False).send_keys(files(("my-stoner.png", PNG)))
    ui.toast("Your cover is on “Stoner”")
    ui.until(lambda: ui.find('img[alt="Cover of Stoner"]', drawer).get_attribute("src").endswith(".webp"),
             "the uploaded cover")
    ui.find(ui.tid("cover-input"), drawer, visible=False).send_keys(files(("notes.png", b"not a picture")))
    ui.toast("Couldn't use that picture")


def test_attach_a_text_file_to_a_book_that_has_none(ui, files):
    title = f"Desert Notes {RUN}"
    add_book(title)
    ui.reload()
    drawer = ui.open_book(title)
    assert not [b for b in ui.visible("button", drawer) if b.text == "Read this book"]
    chapter = "\n\n".join(f"Paragraph {i + 1}. The spice must flow across the desert of Arrakis." for i in range(60))
    ui.find(ui.tid("attach-input"), drawer, visible=False).send_keys(files(("notes.txt", chapter)))
    ui.toast(f"“{title}” is ready to read")
    ui.click("Read this book", root=drawer)
    ui.until(lambda: any("Paragraph 1." in el.text for el in ui.all(".page-body")), "the text in the reader")


def test_edit_details_puts_a_book_in_a_series(ui):
    drawer = ui.open_book("Rebecca")
    ui.click("Edit details", root=drawer)
    dialog = ui.dialog("Edit details", exact=True)
    ui.fill("Series", "Gothic Classics", dialog)
    ui.press(Keys.ESCAPE)  # closes only the dialog, not the drawer
    ui.until(lambda: len(ui.visible('[role="dialog"]')) == 1, "only the drawer to stay open")
    drawer = ui.dialog("Rebecca", exact=True)

    ui.click("Edit details", root=drawer)
    dialog = ui.dialog("Edit details", exact=True)
    ui.fill("What is it about?", "A haunting gothic tale of a second wife and a house full of memories.", dialog)
    ui.fill("Series", "Gothic Classics", dialog)
    ui.fill("Number in series", "1", dialog)
    ui.click("Save", root=dialog)
    ui.toast("Saved “Rebecca”")
    ui.click("Book 1 in Gothic Classics", root=ui.dialog("Rebecca", exact=True))
    ui.until(lambda: ui.find("h1").text == "Gothic Classics", "the series page")
    assert "1 book ·" in ui.find(".lib-head p").text  # not "1 books"


def test_removing_a_book_asks_for_confirmation(ui):
    title = f"Book To Remove {RUN}"
    add_book(title)
    ui.reload()
    start = ui.book_count()
    drawer = ui.open_book(title)
    ui.click("Remove from library", root=drawer)
    ui.click("Cancel", root=ui.dialog("Remove book?", role="alertdialog"))
    assert ui.book_count() == start
    ui.click("Remove from library", root=drawer)
    ui.click("Remove", root=ui.dialog("Remove book?", role="alertdialog"))
    ui.until(lambda: ui.book_count() == start - 1, "the book to be removed")
