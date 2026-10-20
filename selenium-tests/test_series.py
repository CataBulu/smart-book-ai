from selenium.webdriver.common.by import By

from conftest import RUN


def open_series_dialog(ui):
    ui.go_library()
    ui.click("Add books")
    ui.click("A whole series", exact=False)


def open_series_page(ui, name: str):
    ui.fill("Search library", name)
    ui.text_el(name, root=ui.find(ui.tid("series-card"))).click()
    ui.until(lambda: ui.visible(ui.tid("series-book")), "the series page")


def text(el) -> str:
    return " ".join(el.get_attribute("textContent").split())  # books fade in one by one: .text is "" until visible


def series_order(ui) -> list[tuple[str, str]]:
    return [(text(b.find_element(By.CSS_SELECTOR, ".series-no")), text(b.find_element(By.TAG_NAME, "b")))
            for b in ui.all(ui.tid("series-book"))]


def test_add_a_whole_series_then_reorder_it(ui, files):
    name = f"Salt Saga {RUN}"
    open_series_dialog(ui)
    ui.fill("Series name", name)
    ui.fill("Author", "Ada Stone")
    body = "The caravan crossed the salt flats at dawn. " * 60
    ui.find(ui.tid("import-input"), visible=False).send_keys(
        files(*((f"Saga {n} {RUN}.md", f"# Saga {n} {RUN}\n\n{body}") for n in (2, 1, 3))))
    staged = lambda: ui.all("li", ui.find(ui.tid("staged-files")))  # noqa: E731
    ui.until(lambda: len(staged()) == 3, "three chosen files")
    assert f"Saga 1 {RUN}.md" in staged()[0].text  # sorted by file name
    ui.click("Continue with 3 files")

    bulk = ui.find(ui.tid("bulk-list"))
    title = lambda i: ui.field(f"Title {i}", bulk).get_attribute("value")  # noqa: E731
    ui.until(lambda: [title(i) for i in (1, 2, 3)] == [f"Saga {n} {RUN}" for n in (1, 2, 3)], "the books in order")
    assert ui.field("Author 1", bulk).get_attribute("value") == "Ada Stone"
    rows = ui.all("li", bulk)
    ui.drag(rows[2], rows[0])  # drag "Saga 3" to the top
    ui.until(lambda: title(1) == f"Saga 3 {RUN}", "Saga 3 at the top")
    ui.click(f"Move Saga 2 {RUN} up", root=bulk)
    ui.until(lambda: [title(i) for i in (1, 2, 3)] == [f"Saga {n} {RUN}" for n in (3, 2, 1)], "the buttons to reorder")
    ui.click("Add all 3")
    ui.toast("Added 3 books")

    open_series_page(ui, name)
    ui.until(lambda: series_order(ui) == [("#1", f"Saga 3 {RUN}"), ("#2", f"Saga 2 {RUN}"), ("#3", f"Saga 1 {RUN}")],
             "the series in the chosen order")
    assert text(ui.find(ui.tid("series-read"), visible=False)) == "Not started · 0%"

    rows = ui.all(".series-item")
    ui.drag(rows[2], rows[0])  # Saga 1 to the front
    ui.toast(f"New reading order saved for {name}")
    ui.until(lambda: series_order(ui)[0] == ("#1", f"Saga 1 {RUN}"), "the series renumbered")
    ui.click(f"Move Saga 1 {RUN} later", root=ui.hover(ui.all(".series-item")[0]))
    ui.until(lambda: series_order(ui)[:2] == [("#1", f"Saga 3 {RUN}"), ("#2", f"Saga 1 {RUN}")], "the button move")

    ui.reload()
    ui.go_library()
    open_series_page(ui, name)
    ui.until(lambda: series_order(ui)[:2] == [("#1", f"Saga 3 {RUN}"), ("#2", f"Saga 1 {RUN}")],
             "the order to be saved on the server")


def test_a_series_can_start_as_typed_titles(ui):
    name = f"Winter Tales {RUN}"
    open_series_dialog(ui)
    ui.fill("Series name", name)
    ui.text_el("No files yet? Type the titles instead").click()
    ui.fill("Titles, one per line", f"First Frost {RUN}\nDeep Snow {RUN}")
    ui.click("Continue with these titles")
    ui.click("Add all 2")
    ui.toast("Added 2 books")
    open_series_page(ui, name)
    ui.until(lambda: [text(el) for el in ui.all(ui.tid("series-read"))] == ["No text yet", "No text yet"],
             "both entries without text")


def test_files_can_be_chosen_before_naming_the_series(ui, files):
    open_series_dialog(ui)
    picker = ui.find(ui.tid("import-input"), visible=False)
    ui.d.execute_script("arguments[0].addEventListener('click', (e) => { e.preventDefault(); window.__picked = true })",
                        picker)
    ui.click("Drop all the books of the series here, or click to choose", exact=False)
    assert ui.d.execute_script("return window.__picked === true"), "the drop zone opens the file picker without a name"
    picker.send_keys(files(("Tide 1.txt", "The tide came in. " * 40)))
    ui.click("Continue")
    ui.text_el("Name the series first, e.g. Sherlock Holmes.")
    assert ui.d.switch_to.active_element == ui.field("Series name")
