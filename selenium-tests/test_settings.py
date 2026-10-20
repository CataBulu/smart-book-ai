import json

from selenium.webdriver.support.ui import Select


def test_dark_mode_from_settings_persists_across_reloads(ui):
    ui.click("Settings")
    ui.click("Dark", root=ui.dialog("Settings", exact=True))
    ui.until(lambda: ui.theme() == "dark", "dark mode")
    ui.reload()
    assert ui.theme() == "dark"


def test_header_switch_toggles_day_and_night(ui):
    toggle = ui.button("Dark mode")
    after = "light" if ui.theme() == "dark" else "dark"
    toggle.click()
    ui.until(lambda: ui.theme() == after, f"{after} mode")
    assert toggle.get_attribute("aria-checked") == str(after == "dark").lower()
    ui.reload()
    assert ui.theme() == after


def test_answer_speed_reading_voice_and_hardware_panel(ui):
    ui.click("Settings")
    popover = ui.dialog("Settings", exact=True)
    ui.click("Fast", root=popover)
    ui.until(lambda: ui.button("Fast", root=popover).get_attribute("aria-pressed") == "true", "Fast to be chosen")
    assert ui.button("Best", root=popover).get_attribute("aria-pressed") == "false"

    voice = Select(ui.field("Reading voice", popover))
    ui.until(lambda: len(voice.options) > 1, "the voices to load")
    choice = voice.options[-1].get_attribute("value")
    voice.select_by_value(choice)
    ui.text_el("Hardware", root=popover)

    prefs = json.loads(ui.d.execute_script("return localStorage.getItem('smartbook-prefs')"))
    assert prefs["model"] == "lite" and prefs["voice"] == choice
    ui.reload()
    ui.click("Settings")
    assert ui.button("Fast", root=ui.dialog("Settings", exact=True)).get_attribute("aria-pressed") == "true"
