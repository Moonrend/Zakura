#!/usr/bin/python3
"""Bounded AT-SPI observations and live ref resolution on the workspace bus.

The server owns eN refs. Handles here use the accessibility bus's unique name
and object path, never child indexes or cached screen coordinates. No daemon or
public port is needed; each invocation joins the same desktop D-Bus session.
"""

import hashlib
import json
import os
import sys
import time

ACCESSIBLE = "org.a11y.atspi.Accessible"
COMPONENT = "org.a11y.atspi.Component"
ACTION = "org.a11y.atspi.Action"
TEXT = "org.a11y.atspi.Text"
EDITABLE_TEXT = "org.a11y.atspi.EditableText"
PROPERTIES = "org.freedesktop.DBus.Properties"
ROOT = ("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root")
REFRESH = "Run computer_observe observe=snapshot again."
CALL_TIMEOUT = 0.8
WINDOW_ROLES = {"frame", "dialog", "window", "alert", "file chooser"}


class Accessibility:
    def __init__(self):
        # Debian's system Python is intentional: workspace venvs need not have GI.
        try:
            import dbus
            import gi
            gi.require_version("Atspi", "2.0")
            from gi.repository import Atspi
        except (ImportError, ValueError) as exc:
            raise RuntimeError(
                "Desktop accessibility unavailable: install python3-dbus, python3-gi, "
                "gir1.2-atspi-2.0 and at-spi2-core in the workspace image. "
                "Use computer_observe observe=screenshot for coordinate input."
            ) from exc
        self.dbus = dbus
        self.states = Atspi.StateType
        os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/zakura-display/session-bus")
        try:
            session = dbus.SessionBus(private=True)
            service = session.get_object("org.a11y.Bus", "/org/a11y/bus", introspect=False)
            address = service.get_dbus_method("GetAddress", "org.a11y.Bus")(timeout=3)
            self.bus = dbus.bus.BusConnection(address)
            self.session = str(self.bus.get_object(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", introspect=False
            ).get_dbus_method("GetId", "org.freedesktop.DBus")(timeout=CALL_TIMEOUT))
        except dbus.DBusException as exc:
            raise RuntimeError(
                "Desktop accessibility bus unavailable. Check the shared D-Bus session "
                "and /var/log/zakura/a11y.log; rebuild/recreate older workspace images. "
                "Use computer_observe observe=screenshot for coordinate input."
            ) from exc

    def call(self, target, interface, method, *args):
        obj = self.bus.get_object(str(target[0]), str(target[1]), introspect=False)
        return obj.get_dbus_method(method, interface)(*args, timeout=CALL_TIMEOUT)

    def properties(self, target, interface=ACCESSIBLE):
        # The AT-SPI registry implements Get but some versions return no value
        # for GetAll (even though application bridges support it).
        return {name: self.call(target, PROPERTIES, "Get", interface, name) for name in ("Name", "Parent")}

    def read(self, target):
        props = self.properties(target)
        role = str(self.call(target, ACCESSIBLE, "GetRoleName"))
        name = str(props.get("Name", ""))
        bits = self.call(target, ACCESSIBLE, "GetState")

        def has(state):
            number = int(getattr(self.states, state))
            return number // 32 < len(bits) and bool(int(bits[number // 32]) & (1 << (number % 32)))

        signature = hashlib.sha256(json.dumps(
            [role, name, list(props.get("Parent", ()))], ensure_ascii=True
        ).encode()).hexdigest()
        return props, role, name, has, signature

    def bounds(self, target, interfaces):
        if COMPONENT not in interfaces:
            return None
        rect = self.call(target, COMPONENT, "GetExtents", self.dbus.UInt32(0))  # SCREEN
        x, y, width, height = map(int, rect)
        if width <= 0 or height <= 0:
            return None
        return {"x": x, "y": y, "width": width, "height": height}

    def insert_text(self, target, text):
        # Use character offsets, but ATK's InsertText length is UTF-8 *bytes*.
        # This also avoids xdotool's temporary keymap races for Unicode input.
        if not text:
            return
        caret = int(self.call(target, PROPERTIES, "Get", TEXT, "CaretOffset"))
        selections = int(self.call(target, TEXT, "GetNSelections"))
        if caret < 0 or selections > 1:
            raise RuntimeError("Cannot determine a single insertion position. " + REFRESH)
        if selections:
            start, end = map(int, self.call(target, TEXT, "GetSelection", 0))
            if start < 0 or end < start:
                raise RuntimeError("Invalid text selection. " + REFRESH)
            if not self.call(target, EDITABLE_TEXT, "DeleteText", start, end):
                raise RuntimeError("Text selection deletion was not confirmed; observe before repeating. " + REFRESH)
            caret = start
        if not self.call(target, EDITABLE_TEXT, "InsertText", caret, text, len(text.encode("utf-8"))):
            raise RuntimeError("Text insertion was not confirmed; observe before repeating. " + REFRESH)
        if not self.call(target, TEXT, "SetCaretOffset", caret + len(text)):
            raise RuntimeError("Text was inserted but the caret could not be updated; observe before repeating. " + REFRESH)

    def snapshot(self, max_nodes):
        items, warnings, seen = [], [], set()
        deadline = time.monotonic() + 12
        remaining_text = 24000
        truncated = False
        context = {"name": "Desktop", "applications": [], "activeWindow": None, "focusedElement": None}

        def optional(operation, fallback):
            try:
                return operation()
            except self.dbus.DBusException:
                if not warnings:
                    warnings.append("Some accessibility interfaces could not be read; the tree may be incomplete.")
                return fallback

        def visit(target, depth, level):
            nonlocal truncated, remaining_text
            key = tuple(map(str, target))
            if key in seen or key[1] == "/org/a11y/atspi/null":
                return
            if len(items) >= max_nodes or len(seen) >= 2500 or level > 40 or time.monotonic() >= deadline or remaining_text <= 0:
                truncated = True
                return
            seen.add(key)
            try:
                props, role, name, has, signature = self.read(key)
                if has("DEFUNCT"):
                    return
                structural = role in {"desktop frame", "application"}
                showing = has("SHOWING")
                interfaces = list(map(str, self.call(key, ACCESSIBLE, "GetInterfaces")))
                actions, text = [], ""
                if showing:
                    if ACTION in interfaces:
                        actions = [str(action[0])[:80] for action in optional(lambda: self.call(key, ACTION, "GetActions"), [])][:16]
                    # Password fields must never expose their Text interface contents.
                    if TEXT in interfaces and role != "password text":
                        text = str(optional(lambda: self.call(key, TEXT, "GetText", 0, 500), ""))[:500]
                include = structural or (showing and (name or text or actions or has("FOCUSABLE") or role in WINDOW_ROLES))
                if include:
                    name = name[:200]
                    text = text[:max(0, remaining_text - len(name))]
                    remaining_text -= len(name) + len(text)
                    item = {
                        "handle": {"bus": key[0], "path": key[1], "signature": signature},
                        "depth": depth, "role": role[:80], "name": name,
                        "text": text if text != name else "",
                        "actions": actions, "enabled": has("ENABLED") and has("SENSITIVE"),
                        "focusable": has("FOCUSABLE"), "focused": has("FOCUSED"),
                        "editable": has("EDITABLE"), "showing": showing,
                        "selected": has("SELECTED"), "checked": has("CHECKED"),
                    }
                    items.append(item)
                    if role == "desktop frame":
                        context["name"] = name or "Desktop"
                    if role == "application":
                        context["applications"].append(name)
                    if role in WINDOW_ROLES and has("ACTIVE"):
                        context["activeWindow"] = {"role": role, "name": name}
                    if has("FOCUSED"):
                        context["focusedElement"] = {"role": role, "name": name}
                    depth += 1
                for child in self.call(key, ACCESSIBLE, "GetChildren"):
                    visit(child, depth, level + 1)
                    if truncated:
                        break
            except self.dbus.DBusException:
                # A disappearing/hung app must not hide other applications.
                if key == ROOT:
                    raise RuntimeError("AT-SPI desktop registry unavailable. Check at-spi2-core and the desktop D-Bus session.")
                if not warnings:
                    warnings.append("Some accessibility nodes could not be read; the tree may be incomplete. Observe again if needed.")

        visit(ROOT, 0, 0)
        if not context["applications"]:
            warnings.append("No accessible applications found. Enable the application's AT-SPI bridge, or use a screenshot and coordinates.")
        if truncated:
            warnings.append("Accessibility snapshot was truncated by node, text, depth or time limits; use a screenshot for omitted controls.")
        return {"session": self.session, "context": context, "items": items, "truncated": truncated, "warnings": warnings}

    def resolve(self, request):
        if request.get("session") != self.session:
            raise RuntimeError("Desktop accessibility session changed; refs are stale. " + REFRESH)
        targets = request["targets"]
        resolved = []
        # Resolve *all* drag endpoints before any focus/input side effect.
        for handle in targets:
            target = (handle["bus"], handle["path"])
            try:
                _, role, name, has, signature = self.read(target)
                if signature != handle["signature"] or has("DEFUNCT") or not has("SHOWING"):
                    raise RuntimeError("Desktop ref changed or is no longer visible. " + REFRESH)
                if not has("ENABLED") or not has("SENSITIVE"):
                    raise RuntimeError("Desktop ref is disabled. " + REFRESH)
                interfaces = list(map(str, self.call(target, ACCESSIBLE, "GetInterfaces")))
                resolved.append((target, interfaces, role, has("EDITABLE"), has("FOCUSED")))
            except self.dbus.DBusException as exc:
                raise RuntimeError("Desktop ref is no longer available. " + REFRESH) from exc

        mode = request.get("mode", "point")
        if mode == "click" and len(resolved) == 1:
            target, interfaces, role, editable, _ = resolved[0]
            if ACTION in interfaces:
                actions = self.call(target, ACTION, "GetActions")
                for index, action in enumerate(actions):
                    action_name = str(action[0]).lower()
                    # An entry's Activate submits it; clicking an entry must only
                    # place focus/caret. Restrict semantic activation to controls.
                    activate = action_name == "activate" and role in {"button", "push button", "toggle button", "menu item", "link", "check box", "radio button", "page tab"}
                    if not editable and (action_name in {"click", "press"} or activate):
                        if not self.call(target, ACTION, "DoAction", index):
                            raise RuntimeError("AT-SPI click was not confirmed; observe before repeating the action. " + REFRESH)
                        return {"handled": True, "method": "at-spi-action"}
        if mode in {"focus", "type"} and len(resolved) == 1:
            target, interfaces, _, editable, focused = resolved[0]
            # Re-grabbing focus can select all text in GTK entries, even when
            # already focused. Preserve the current caret/selection in that case.
            if not focused and (COMPONENT not in interfaces or not self.call(target, COMPONENT, "GrabFocus")):
                raise RuntimeError("Cannot focus desktop ref; no text/key was sent. " + REFRESH)
            deadline = time.monotonic() + 1
            while True:
                _, _, _, has, signature = self.read(target)
                if signature != targets[0]["signature"] or has("DEFUNCT") or not has("SHOWING") or not has("ENABLED") or not has("SENSITIVE"):
                    raise RuntimeError("Desktop ref changed while taking focus; no text/key was sent. " + REFRESH)
                if has("FOCUSED"):
                    if mode == "type" and editable and TEXT in interfaces and EDITABLE_TEXT in interfaces:
                        self.insert_text(target, request["text"])
                        return {"handled": True, "typed": True, "method": "at-spi-editable-text"}
                    return {"handled": True, "typed": False, "method": "at-spi-focus"}
                if time.monotonic() >= deadline:
                    raise RuntimeError("Desktop ref did not take focus; no text/key was sent. " + REFRESH)
                time.sleep(0.05)

        points = []
        width, height = request["width"], request["height"]
        for target, interfaces, _, _, _ in resolved:
            rect = self.bounds(target, interfaces)
            if rect is None:
                raise RuntimeError("Desktop ref has no screen bounds; use a screenshot and coordinates. " + REFRESH)
            left, top = max(0, rect["x"]), max(0, rect["y"])
            right, bottom = min(width, rect["x"] + rect["width"]), min(height, rect["y"] + rect["height"])
            if right <= left or bottom <= top:
                raise RuntimeError("Desktop ref is outside the display. " + REFRESH)
            points.append({"x": (left + right - 1) // 2, "y": (top + bottom - 1) // 2})
        return {"points": points, "method": "at-spi-bounds"}


def main():
    try:
        command = sys.argv[1]
        request = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        backend = Accessibility()
        if command == "probe":
            result = {"ready": True, "backend": "at-spi"}
        elif command == "snapshot":
            result = backend.snapshot(max(1, min(500, int(request.get("maxNodes", 300)))))
        elif command == "resolve":
            result = backend.resolve(request)
        else:
            raise RuntimeError("Unknown accessibility command")
        print(json.dumps(result, ensure_ascii=True))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
