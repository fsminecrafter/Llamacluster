"""Small optional chat tools: convert_units and date_time.  Pure standard library."""
import datetime as _dt
import re

from calc import CalcError, fmt


class ExtraError(Exception):
    pass


# ------------------------------------------------------------------ units
# category -> {unit: factor to the category's base unit}.  Temperature is handled separately.
_U = {
    "length": {"m": 1, "meter": 1, "metre": 1, "km": 1e3, "cm": 1e-2, "mm": 1e-3, "um": 1e-6, "nm": 1e-9,
               "mi": 1609.344, "mile": 1609.344, "yd": 0.9144, "yard": 0.9144, "ft": 0.3048, "foot": 0.3048,
               "feet": 0.3048, "in": 0.0254, "inch": 0.0254, "nmi": 1852, "au": 1.495978707e11,
               "ly": 9.4607304725808e15, "pc": 3.0856775814913673e16},
    "mass": {"kg": 1, "g": 1e-3, "mg": 1e-6, "ug": 1e-9, "t": 1e3, "tonne": 1e3, "lb": 0.45359237, "lbs": 0.45359237,
             "oz": 0.028349523125, "st": 6.35029318, "stone": 6.35029318, "ton": 907.18474, "carat": 2e-4},
    "time": {"s": 1, "sec": 1, "ms": 1e-3, "us": 1e-6, "ns": 1e-9, "min": 60, "h": 3600, "hr": 3600, "hour": 3600,
             "d": 86400, "day": 86400, "wk": 604800, "week": 604800, "yr": 31557600, "year": 31557600},
    "volume": {"l": 1e-3, "litre": 1e-3, "liter": 1e-3, "ml": 1e-6, "m3": 1, "cm3": 1e-6, "cc": 1e-6,
               "gal": 3.785411784e-3, "qt": 9.46352946e-4, "pt": 4.73176473e-4, "cup": 2.365882365e-4,
               "floz": 2.95735295625e-5, "tbsp": 1.478676478125e-5, "tsp": 4.92892159375e-6,
               "imp_gal": 4.54609e-3, "imp_pt": 5.68261e-4},
    "area": {"m2": 1, "km2": 1e6, "cm2": 1e-4, "mm2": 1e-6, "ha": 1e4, "acre": 4046.8564224, "ft2": 0.09290304,
             "in2": 6.4516e-4, "yd2": 0.83612736, "mi2": 2589988.110336},
    "speed": {"m/s": 1, "km/h": 1 / 3.6, "kph": 1 / 3.6, "mph": 0.44704, "kn": 1852 / 3600, "knot": 1852 / 3600,
              "ft/s": 0.3048, "mach": 340.29},
    "energy": {"j": 1, "kj": 1e3, "mj": 1e6, "cal": 4.184, "kcal": 4184, "wh": 3600, "kwh": 3.6e6, "btu": 1055.05585262,
               "ev": 1.602176634e-19, "ft_lb": 1.3558179483314004},
    "power": {"w": 1, "kw": 1e3, "mw": 1e6, "hp": 745.69987158227, "ps": 735.49875},
    "pressure": {"pa": 1, "kpa": 1e3, "mpa": 1e6, "bar": 1e5, "mbar": 100, "atm": 101325, "psi": 6894.757293168,
                 "mmhg": 133.322387415, "torr": 133.32236842105263},
    "angle": {"rad": 1, "deg": 3.141592653589793 / 180, "grad": 3.141592653589793 / 200,
              "turn": 6.283185307179586, "arcmin": 3.141592653589793 / 10800, "arcsec": 3.141592653589793 / 648000},
    "force": {"n": 1, "kn": 1e3, "lbf": 4.4482216152605, "kgf": 9.80665, "dyn": 1e-5},
    "frequency": {"hz": 1, "khz": 1e3, "mhz": 1e6, "ghz": 1e9, "rpm": 1 / 60},
    # data units are case-sensitive (MB vs Mb), looked up before lowercasing
    "data": {"bit": 1, "b": 8, "byte": 8, "B": 8, "kB": 8e3, "MB": 8e6, "GB": 8e9, "TB": 8e12, "PB": 8e15,
             "KiB": 8192, "MiB": 8 * 1024 ** 2, "GiB": 8 * 1024 ** 3, "TiB": 8 * 1024 ** 4,
             "kb": 1e3, "Mb": 1e6, "Gb": 1e9, "Tb": 1e12, "kbit": 1e3, "Mbit": 1e6, "Gbit": 1e9},
}
_TEMP = {"c": "c", "celsius": "c", "°c": "c", "f": "f", "fahrenheit": "f", "°f": "f", "k": "k", "kelvin": "k",
         "r": "r", "rankine": "r"}
_ALIAS = {"metres": "m", "meters": "m", "kilometers": "km", "kilometres": "km", "miles": "mi", "yards": "yd",
          "inches": "in", "feet": "ft", "foot": "ft", "pounds": "lb", "pound": "lb", "ounces": "oz", "grams": "g",
          "kilograms": "kg", "seconds": "s", "minutes": "min", "hours": "h", "days": "d", "weeks": "wk",
          "years": "yr", "litres": "l", "liters": "l", "gallons": "gal", "gallon": "gal", "mph": "mph",
          "km/hr": "km/h", "m/sec": "m/s", "m²": "m2", "km²": "km2", "cm²": "cm2", "ft²": "ft2", "m³": "m3",
          "cm³": "cm3", "µm": "um", "μm": "um", "degrees": "deg", "degree": "deg", "radians": "rad",
          "kilowatt": "kw", "watts": "w", "watt": "w", "joules": "j", "calories": "kcal", "bytes": "byte",
          "bits": "bit", "kilobytes": "kB", "megabytes": "MB", "gigabytes": "GB", "terabytes": "TB",
          "hertz": "hz", "newtons": "n", "kilonewton": "kn", "horsepower": "hp", "atmospheres": "atm"}


def _unit(u):
    raw = str(u).strip()
    if raw in _ALIAS:
        raw = _ALIAS[raw]
    low = raw.lower()
    if low in _ALIAS:
        low = _ALIAS[low]
    if low in _TEMP:
        return "temperature", _TEMP[low], raw
    for cat, table in _U.items():
        if cat == "data":
            if raw in table:
                return cat, table[raw], raw
            continue
        if low in table:
            return cat, table[low], raw
    # last resort for data: case-insensitive
    for k, v in _U["data"].items():
        if k.lower() == low:
            return "data", v, raw
    raise ExtraError("unknown unit '%s'. Supported: length, mass, time, volume, area, speed, energy, power, pressure, "
                     "angle, force, frequency, data size and temperature (C, F, K, R)." % u)


def _to_k(v, t):
    return {"c": v + 273.15, "f": (v - 32) * 5 / 9 + 273.15, "k": v, "r": v * 5 / 9}[t]


def _from_k(k, t):
    return {"c": k - 273.15, "f": (k - 273.15) * 9 / 5 + 32, "k": k, "r": k * 9 / 5}[t]


def convert_units(value, from_unit, to_unit):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ExtraError("value must be a number")
    c1, f1, n1 = _unit(from_unit)
    c2, f2, n2 = _unit(to_unit)
    if c1 != c2:
        raise ExtraError("cannot convert %s (%s) to %s (%s)" % (n1, c1, n2, c2))
    if c1 == "temperature":
        k = _to_k(v, f1)
        if k < 0:
            raise ExtraError("below absolute zero")
        out = _from_k(k, f2)
    else:
        out = v * f1 / f2
    return {"value": v, "from": n1, "to": n2, "result": float("%.12g" % out), "text": "%s %s = %s %s" % (
        fmt(v), n1, fmt(float("%.12g" % out)), n2)}


# ------------------------------------------------------------------ date and time
def _tz(name):
    if name in (None, "", "local"):
        return _dt.datetime.now().astimezone().tzinfo
    n = str(name).strip()
    if n.upper() in ("UTC", "Z", "GMT"):
        return _dt.timezone.utc
    m = re.fullmatch(r"(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?", n)
    if m:
        off = _dt.timedelta(hours=int(m.group(2)), minutes=int(m.group(3) or 0))
        return _dt.timezone(-off if m.group(1) == "-" else off)
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(n)
    except Exception:
        raise ExtraError("unknown time zone '%s' - use an IANA name like Europe/Stockholm or America/New_York, "
                         "UTC, or an offset like +02:00 (IANA names need the tzdata package on Windows)" % name)


def _parse(text, tz):
    t = str(text).strip()
    if t.lower() == "now":
        return _dt.datetime.now(tz)
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        d = _dt.datetime.fromisoformat(t)
    except ValueError:
        for f in ("%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%Y/%m/%d", "%b %d %Y", "%B %d %Y"):
            try:
                d = _dt.datetime.strptime(t, f)
                break
            except ValueError:
                d = None
        if d is None:
            raise ExtraError("could not read the date '%s' - use ISO format like 2026-11-08 or 2026-11-08T14:30" % text)
    return d if d.tzinfo else d.replace(tzinfo=tz)


def _out(d):
    return {"iso": d.isoformat(timespec="seconds"), "date": d.strftime("%Y-%m-%d"), "time": d.strftime("%H:%M:%S"),
            "weekday": d.strftime("%A"), "timezone": d.tzname() or str(d.tzinfo),
            "utc_offset": d.strftime("%z"), "unix": int(d.timestamp()), "iso_week": d.isocalendar()[1],
            "day_of_year": d.timetuple().tm_yday}


def _add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    import calendar
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def date_time(action="now", datetime="", tz="", to_tz="", end="", days=0, hours=0, minutes=0, weeks=0,
              months=0, years=0):
    zone = _tz(tz)
    if action == "now":
        return _out(_dt.datetime.now(zone))
    if action == "convert":
        d = _parse(datetime or "now", zone)
        return {"from": _out(d), "to": _out(d.astimezone(_tz(to_tz or "UTC")))}
    if action == "add":
        d = _parse(datetime or "now", zone)
        try:
            d = _add_months(d, int(months) + 12 * int(years)) if (months or years) else d
            d = d + _dt.timedelta(days=float(days), hours=float(hours), minutes=float(minutes), weeks=float(weeks))
        except (OverflowError, ValueError):
            raise ExtraError("result is out of range")
        return _out(d)
    if action == "diff":
        a, b = _parse(datetime or "now", zone), _parse(end or "now", zone)
        s = (b - a).total_seconds()
        sign = "-" if s < 0 else ""
        s = abs(s)
        dd, r = divmod(int(s), 86400)
        hh, r = divmod(r, 3600)
        mm, ss = divmod(r, 60)
        return {"from": a.isoformat(timespec="seconds"), "to": b.isoformat(timespec="seconds"),
                "text": "%s%d days, %d h, %d min, %d s" % (sign, dd, hh, mm, ss),
                "total_days": round((b - a).total_seconds() / 86400, 6),
                "total_hours": round((b - a).total_seconds() / 3600, 4),
                "total_seconds": int((b - a).total_seconds())}
    if action == "weekday":
        return _out(_parse(datetime, zone))
    raise ExtraError("action must be one of: now, convert, add, diff, weekday")


__all__ = ["convert_units", "date_time", "ExtraError", "CalcError"]
