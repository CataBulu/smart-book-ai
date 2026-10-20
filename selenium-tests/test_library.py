from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select

from conftest import RUN


def test_add_a_book_by_hand_import_a_markdown_file_and_search(ui, files):
    start = ui.book_count()
    ui.go_library()
    ui.text_el("Your library")

    ui.click("Add books")
    ui.click("One book", exact=False)
    dialog = ui.dialog("Add")
    ui.click("Enter details", root=dialog)
    ui.fill("Title", f"The Lantern Keeper {RUN}", dialog)
    ui.fill("Author", "Ivy Marsh", dialog)
    ui.fill("What is it about?", "A lighthouse keeper finds peace in solitude on a stormy island.", dialog)
    ui.fill("Themes", "solitude, the sea", dialog)
    ui.click("Add to library", root=dialog)
    ui.toast(f"Added “The Lantern Keeper {RUN}” to your library")
    ui.until(lambda: ui.book_count() == start + 1, "the new book to be counted")

    ui.click("Add books")
    ui.click("One book", exact=False)
    river = f"---\ntitle: The Slow River {RUN}\nauthor: Ana Moss\n---\nA barge drifts through quiet English towns."
    ui.find(ui.tid("import-input"), visible=False).send_keys(files(("river.md", river)))
    ui.until(lambda: "river.md" in ui.find(ui.tid("staged-files")).text, "the chosen file to be listed")
    ui.click("Continue")
    dialog = ui.dialog("Add")
    ui.until(lambda: ui.field("Title", dialog).get_attribute("value") == f"The Slow River {RUN}", "the file's title")
    ui.click("Add to library", root=dialog)
    ui.until(lambda: ui.book_count() == start + 2, "the imported book to be counted")

    ui.fill("Search library", f"slow river {RUN}")
    ui.until(lambda: len(ui.visible(ui.tid("book-card"))) == 1, "one search result")


def test_genre_chips_filter_the_shelves(ui):
    ui.go_library()
    total = len(ui.visible(ui.tid("book-card")))
    chip = ui.button("Fantasy")
    chip.click()
    ui.until(lambda: chip.get_attribute("aria-pressed") == "true", "the chip to be pressed")
    ui.until(lambda: 0 < len(ui.visible(ui.tid("book-card"))) < total, "only fantasy books")
    chip.click()
    ui.until(lambda: len(ui.visible(ui.tid("book-card"))) == total, "every book again")


def test_your_own_shelf_order_is_saved_and_sort_switches_views(ui):
    ui.go_library()
    Select(ui.field("Sort books")).select_by_value("custom")
    first, _, third = ui.grid_titles()[:3]

    items = ui.all(ui.tid("grid-item"))
    ui.drag(items[2], items[0])  # drag the third book to the front
    ui.until(lambda: ui.grid_titles()[:2] == [third, first], "the dragged book at the front")

    # Alt + arrow keys move the focused book; the ← → buttons move it one place too
    ui.book_card(third).send_keys(Keys.ALT, Keys.ARROW_RIGHT)
    ui.until(lambda: ui.grid_titles()[:2] == [first, third], "Alt+→ to move it one place")
    ui.click(f"Move {third} left", root=ui.hover(ui.all(ui.tid("grid-item"))[1]))
    ui.until(lambda: ui.grid_titles()[:2] == [third, first], "← to move it back")

    ui.reload()
    ui.go_library()
    ui.until(lambda: ui.grid_titles()[:2] == [third, first], "the order to be saved on the server")

    Select(ui.field("Sort books")).select_by_value("title")
    ui.until(lambda: ui.grid_titles()[0] == "A Gentleman in Moscow", "the title sort")
    ui.fill("Search library", "dune")
    ui.text_el("Clear the search and genre filter to rearrange your shelves.")
    assert ui.all(ui.tid("grid-item"))[0].get_attribute("draggable") == "false"


def test_export_downloads_the_library(ui):
    ui.go_library()
    ui.d.get_log("performance")
    ui.click("Export")
    sent = []
    ui.until(lambda: sent.extend(ui.requests_to("/api/books/export")) or sent, "the export request")


def test_import_shows_a_progress_window_with_a_percentage(ui):
    title = f"The Long Road North {RUN}"
    ui.go_library()
    ui.click("Add books")
    ui.click("One book", exact=False)
    dialog = ui.dialog("Add")
    ui.click("Enter details", root=dialog)
    ui.fill("Title", title, dialog)
    ui.fill("Author", "Mara Quinn", dialog)
    ui.fill("What is it about?", "A courier crosses a frozen country.", dialog)
    ui.fill("Book text or notes", "\n\n".join(
        f"Paragraph {i}. The courier walked north through the snow and the dark pines." for i in range(300)), dialog)
    ui.click("Add to library", root=dialog)

    def job():
        return next((j for j in ui.visible(ui.tid("job")) if f"Adding “{title}”" in j.text), None)
    ui.until(job, "the progress window")
    ui.until(lambda: job() is None or job().find_element(By.CSS_SELECTOR, ui.tid("job-percent")).text == "100%",
             "100% done")
    ui.until(lambda: job() is None, "the progress window to tidy itself away", timeout=10)


def test_add_dialog_cancel_and_the_chosen_files_list(ui, files):
    ui.go_library()
    ui.click("Add books")
    ui.find(ui.tid("dialog-cancel")).click()
    ui.until(lambda: not ui.visible('[role="dialog"]'), "the dialog to close")

    ui.click("Add books")
    ui.click("A whole series", exact=False)
    ui.fill("Series name", "Tide Books")
    story = lambda name: (name, f"A story called {name}. " * 40)  # noqa: E731
    ui.find(ui.tid("import-input"), visible=False).send_keys(files(story("b.txt"), story("a.txt")))
    ui.find(ui.tid("import-input"), visible=False).send_keys(files(story("c.txt"), story("a.txt")))  # a.txt is skipped
    staged = lambda: ui.all("li", ui.find(ui.tid("staged-files")))  # noqa: E731
    ui.until(lambda: len(staged()) == 3, "three distinct files")
    ui.click("Remove b.txt")
    ui.until(lambda: len(staged()) == 2, "b.txt to be removed")
    ui.button("Continue with 2 files")
    ui.find(ui.tid("dialog-cancel")).click()
    ui.until(lambda: not ui.visible('[role="dialog"]'), "the dialog to close")
    assert ui.book_count() > 0
