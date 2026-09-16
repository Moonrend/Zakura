"""Isolated GTK desktop for the opt-in server AT-SPI integration test."""

import json
import os
import signal
import subprocess


def main():
    read_fd, write_fd = os.pipe()
    display = subprocess.Popen(
        ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "800x600x24", "-nolisten", "tcp"],
        pass_fds=(write_fd,), stderr=subprocess.DEVNULL,
    )
    os.close(write_fd)
    with os.fdopen(read_fd) as pipe:
        number = pipe.readline().strip()
    if not number:
        raise RuntimeError("Xvfb did not start")
    os.environ.update(DISPLAY=":" + number, GTK_MODULES="atk-bridge", NO_AT_BRIDGE="0")
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk, GLib

        window = Gtk.Window(title="Zakura AT-SPI fixture")
        window.set_default_size(500, 300)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        window.add(box)
        status = Gtk.Label(label="Ready")
        entry = Gtk.Entry()
        entry.get_accessible().set_name("Message")
        entry.connect("activate", lambda _: status.set_text("Unexpected entry activation"))
        password = Gtk.Entry()
        password.set_visibility(False)
        password.set_text("fixture-secret")
        password.get_accessible().set_name("Password")
        button = Gtk.Button(label="Save")

        def save(_):
            if status.get_text() != "Unexpected entry activation":
                status.set_text("Saved: " + entry.get_text())
            button.set_label("Saved")

        button.connect("clicked", save)
        for widget in (status, entry, password, button):
            box.pack_start(widget, True, True, 0)
        window.show_all()
        window.present()
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, Gtk.main_quit)
        print(json.dumps({"display": os.environ["DISPLAY"], "bus": os.environ["DBUS_SESSION_BUS_ADDRESS"]}), flush=True)
        Gtk.main()
    finally:
        display.terminate()
        display.wait(timeout=3)


if __name__ == "__main__":
    main()
