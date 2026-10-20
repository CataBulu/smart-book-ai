from conftest import UI


def test_phone_layout_has_a_menu_and_the_library_still_works(driver):
    driver.execute_cdp_cmd("Emulation.setDeviceMetricsOverride",
                           {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
    ui = UI(driver).open()
    assert not ui.visible(".stamp"), "the date stamp is hidden on phones"
    sidebar = ui.find('aside[aria-label="Navigation"]', visible=False)
    assert not sidebar.is_displayed()

    ui.click("Open menu")
    ui.until(sidebar.is_displayed, "the sidebar to slide in")
    ui.go_library()
    ui.until(lambda: not sidebar.is_displayed(), "the sidebar to close after choosing")
    ui.text_el("Your library")
    assert len(ui.visible(ui.tid("book-card"))) >= 60
