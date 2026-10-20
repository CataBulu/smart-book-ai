import re
import time

from selenium.webdriver.common.keys import Keys


def open_reader(ui, title: str):
    drawer = ui.open_book(title)
    start = next(b for b in ui.visible("button", drawer)
                 if b.text.startswith(("Read this book", "Continue reading")))  # a second run reopens where it was
    start.click()
    return ui.dialog(f"Reading {title}", exact=True)


def first_page(ui) -> int:
    match = re.match(r"Pages (\d+)–\d+ of", ui.find(ui.tid("reader-page")).text)
    return int(match.group(1)) if match else 0


def test_reader_turns_pages_and_reopens_where_you_left_off(ui):
    reader = open_reader(ui, "The Great Gatsby")
    ui.until(lambda: first_page(ui) > 0, "the two-page spread")
    start = first_page(ui)
    ui.press(Keys.ARROW_RIGHT)
    ui.until(lambda: first_page(ui) == start + 2, "→ to turn a page")
    ui.click("Next page", root=reader)
    ui.until(lambda: first_page(ui) == start + 4, "the next-page button")
    ui.press(Keys.ARROW_LEFT)
    ui.until(lambda: first_page(ui) == start + 2, "← to turn back")
    time.sleep(0.8)  # the position is saved 600 ms after a page turn
    ui.click("Close", root=reader)

    ui.click("New conversation")
    card = ui.wait(lambda d: next((c for c in ui.visible(ui.tid("continue-card")) if "The Great Gatsby" in c.text), None),
                   "the continue-reading card")
    assert f"Page {start + 2}" in card.text
    card.click()
    notice = ui.find('.reader [role="status"]')
    assert "Welcome back" in notice.text and f"page {start + 2}" in notice.text
    ui.until(lambda: first_page(ui) == start + 2, "the saved page")
    ui.press(Keys.ESCAPE)
    ui.until(lambda: not ui.visible(".reader"), "the reader to close")


def test_reader_text_size_buttons(ui):
    reader = open_reader(ui, "Frankenstein")
    size = lambda: ui.d.execute_script(  # noqa: E731
        "return getComputedStyle(arguments[0]).getPropertyValue('--reader-font')", reader)
    ui.until(size, "the reader's text size")
    before = size()
    ui.click("Larger text", root=reader)
    ui.until(lambda: size() != before, "larger text")
    ui.click("Smaller text", root=reader)
    ui.until(lambda: size() == before, "the original size")
