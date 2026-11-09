"""Advanced calculator for the chat's `calculate` tool.  Pure standard library, never uses eval().

Expressions are parsed with `ast` and walked by a small whitelist interpreter, so only maths can run.
Supports: arithmetic (+ - * / // % ** ^ @, 5!), exact rational mode, complex numbers, vectors and matrices,
statistics, number theory, and numeric calculus (diff, integrate, solve, limit, sumto, prodto, polyroots, eigvals).

    calculate("integrate('exp(-x**2)', -inf, inf)")        -> 1.7724538509055159   (= sqrt(pi))
    calculate("solve('cos(x) - x', 0.5)")                    -> 0.7390851332151607
    calculate("det([[2,1],[5,3]])", exact=True)             -> 1
    calculate("factor(600851475143)")                        -> 71 x 839 x 1471 x 6857
"""
import ast
import cmath
import difflib
import heapq
import math
import re
import threading
import time
from fractions import Fraction


class CalcError(Exception):
    pass


MAX_OPS = 800_000          # interpreter steps per call
MAX_SECONDS = 6.0          # wall-clock budget per call
MAX_BITS = 250_000         # largest integer result (bits) we allow ** and friends to produce
MAX_LIST = 1_000_000
MAX_MATRIX = 60
INF = float("inf")
_ctx = threading.local()     # per-thread calculation settings (exact mode)


# ------------------------------------------------------------------ number helpers
def _isnum(x):
    return isinstance(x, (int, float, Fraction, complex))


def _flt(x):
    if isinstance(x, complex):
        if abs(x.imag) <= 1e-12 * max(1.0, abs(x.real)):
            return x.real
        raise CalcError("expected a real number but got a complex one (%s)" % _fmt_c(x, 12))
    try:
        return float(x)
    except OverflowError:
        raise CalcError("number too large to convert to a float")
    except (TypeError, ValueError):
        raise CalcError("expected a number")


def _int(x, what="argument"):
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, int):
        return x
    if isinstance(x, Fraction) and x.denominator == 1:
        return int(x)
    if isinstance(x, float) and x == x and abs(x) != INF and x == int(x):
        return int(x)
    raise CalcError("%s must be a whole number" % what)


def _iroot(x, n):
    """Integer n-th root (floor) of a non-negative int."""
    if x < 2 or n == 1:
        return x
    lo, hi = 0, 1 << (x.bit_length() // n + 1)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if mid ** n <= x:
            lo = mid
        else:
            hi = mid - 1
    return lo


def _exact_pow(base, num, den):
    """base ** (num/den) as an exact Fraction when it is a perfect root, else None."""
    if base < 0:
        return None
    p, q = base.numerator, base.denominator
    rp, rq = _iroot(p, den), _iroot(q, den)
    if rp ** den != p or rq ** den != q:
        return None
    r = Fraction(rp, rq)
    return r ** num if num >= 0 else (Fraction(1) / r) ** (-num) if r != 0 else None


# ------------------------------------------------------------------ number theory
_SMALL_PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71)


def isprime(n):
    n = _int(n, "isprime(n): n")
    if n < 2:
        return False
    if n.bit_length() > 4096:
        raise CalcError("isprime: number too large")
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    bases = _SMALL_PRIMES[:12] if n < 3_317_044_064_679_887_385_961_981 else _SMALL_PRIMES
    for a in bases:
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def nextprime(n):
    n = _int(n) + 1
    n = max(n, 2)
    while not isprime(n):
        n += 1
    return n


def prevprime(n):
    n = _int(n) - 1
    while n >= 2 and not isprime(n):
        n -= 1
    if n < 2:
        raise CalcError("there is no prime below that")
    return n


class _Factors(list):
    """Marks a factorisation so it prints as 2^3 x 5 instead of a nested list."""


def _pollard(n, deadline):
    if n % 2 == 0:
        return 2
    for c in range(1, 60):
        x = y = 2
        d = 1
        f = lambda v: (v * v + c) % n
        it = 0
        while d == 1:
            x, y = f(x), f(f(y))
            d = math.gcd(abs(x - y), n)
            it += 1
            if it & 1023 == 0 and time.monotonic() > deadline:
                return None
        if d != n:
            return d
    return None


def factor(n):
    """Prime factorisation as a list of [prime, exponent] pairs (partial result noted if too hard)."""
    n = _int(n, "factor(n): n")
    if n < 2:
        raise CalcError("factor needs an integer >= 2")
    if n.bit_length() > 200:
        raise CalcError("factor: number too large (limit about 60 digits)")
    out, deadline = {}, time.monotonic() + 4.0
    for p in (2, 3, 5):
        while n % p == 0:
            out[p] = out.get(p, 0) + 1
            n //= p
    p, step = 7, [4, 2, 4, 2, 4, 6, 2, 6]
    i = 0
    while p * p <= n and p < 200_000:
        while n % p == 0:
            out[p] = out.get(p, 0) + 1
            n //= p
        p += step[i % 8]
        i += 1
    stack, rest = [n] if n > 1 else [], 1
    while stack:
        m = stack.pop()
        if m == 1:
            continue
        if isprime(m):
            out[m] = out.get(m, 0) + 1
            continue
        d = _pollard(m, deadline)
        if d is None:
            rest *= m
            continue
        stack += [d, m // d]
    res = _Factors([p, e] for p, e in sorted(out.items()))
    if rest > 1:
        res.append(["composite, not fully factored", rest])
    return res


def divisors(n):
    n = _int(n)
    if n < 1:
        raise CalcError("divisors needs a positive integer")
    fs = factor(n) if n > 1 else []
    if any(isinstance(p, str) for p, _ in fs):
        raise CalcError("divisors: could not factor that number")
    ds = [1]
    for p, e in fs:
        ds = [d * p ** k for d in ds for k in range(e + 1)]
        if len(ds) > 200_000:
            raise CalcError("too many divisors")
    return sorted(ds)


def totient(n):
    n = _int(n)
    if n < 1:
        raise CalcError("totient needs a positive integer")
    r = n
    for p, _ in (factor(n) if n > 1 else []):
        if isinstance(p, str):
            raise CalcError("totient: could not factor that number")
        r -= r // p
    return r


def fib(n):
    n = _int(n, "fib(n): n")
    if n < 0 or n > 300_000:
        raise CalcError("fib: n must be between 0 and 300000")
    a, b = 0, 1
    for bit in bin(n)[2:]:
        c = a * (2 * b - a)
        d = a * a + b * b
        a, b = (d, c + d) if bit == "1" else (c, d)
    return a


def _factorial(n):
    n = _int(n, "factorial(n): n")
    if n < 0:
        raise CalcError("factorial of a negative number is undefined (use gamma for non-integers)")
    if n > 30_000:
        raise CalcError("factorial: n is limited to 30000")
    return math.factorial(n)


def _comb(n, k):
    n, k = _int(n), _int(k)
    if n > 30_000 or n < 0 or k < 0:
        raise CalcError("comb: need 0 <= k and n <= 30000")
    return math.comb(n, k)


def _perm(n, k=None):
    n = _int(n)
    k = n if k is None else _int(k)
    if n > 30_000 or n < 0 or k < 0:
        raise CalcError("perm: need 0 <= k and n <= 30000")
    return math.perm(n, k)


def _pow3(a, b, m=None):
    if m is None:
        return _Ev(getattr(_ctx, "exact", False)).power(a, b)
    a, b, m = _int(a), _int(b), _int(m)
    if m == 0:
        raise CalcError("modulus is zero")
    try:
        return pow(a, b, m)
    except ValueError:
        raise CalcError("no modular inverse exists")


def _modinv(a, m):
    try:
        return pow(_int(a), -1, _int(m))
    except ValueError:
        raise CalcError("no modular inverse exists (a and m are not coprime)")


def _gcd(*a):
    r = 0
    for x in _flat(a):
        r = math.gcd(r, _int(x))
    return r


def _lcm(*a):
    r = 1
    for x in _flat(a):
        r = math.lcm(r, _int(x))
        if r.bit_length() > MAX_BITS:
            raise CalcError("lcm too large")
    return r


def tobase(n, base=2):
    n, base = _int(n), _int(base)
    if not 2 <= base <= 36:
        raise CalcError("base must be 2..36")
    if n == 0:
        return "0"
    digs, sign, n = "0123456789abcdefghijklmnopqrstuvwxyz", "-" if n < 0 else "", abs(n)
    if n.bit_length() > 100_000:
        raise CalcError("number too large to convert")
    out = []
    while n:
        n, r = divmod(n, base)
        out.append(digs[r])
    return sign + "".join(reversed(out))


# ------------------------------------------------------------------ lists / stats / linear algebra
def _flat(a):
    out = []
    for x in a:
        if isinstance(x, list):
            out += _flat(x)
        else:
            out.append(x)
    return out


def _vals(a):
    """Accept f(list) or f(a, b, c)."""
    if len(a) == 1 and isinstance(a[0], list):
        return _flat(a[0])
    return _flat(a)


def _need(v, what):
    if not v:
        raise CalcError("%s needs at least one value" % what)
    return v


def _sum(*a):
    v = _vals(a)
    s = 0
    for x in v:
        s = s + x
    return s


def _prod(*a):
    r = 1
    for x in _vals(a):
        r = r * x
        if isinstance(r, int) and r.bit_length() > MAX_BITS:
            raise CalcError("product too large")
    return r


def _norm_out(x):
    if isinstance(x, Fraction) and x.denominator == 1:
        return int(x)
    return x


def _divx(a, b):
    """a / b that stays an exact fraction when exact mode is on and both sides are exact."""
    if b == 0:
        raise CalcError("division by zero")
    if getattr(_ctx, "exact", False) and isinstance(a, (int, Fraction)) and isinstance(b, (int, Fraction)):
        return _norm_out(Fraction(a) / Fraction(b))
    return a / b


def _mean(*a):
    v = _need(_vals(a), "mean")
    return _divx(_sum(v), len(v))


def _median(*a):
    v = sorted(_need(_vals(a), "median"))
    n = len(v)
    if n % 2:
        return v[n // 2]
    return _divx(v[n // 2 - 1] + v[n // 2], 2)


def _mode(*a):
    v = _need(_vals(a), "mode")
    best, cnt = None, 0
    seen = {}
    for x in v:
        seen[x] = seen.get(x, 0) + 1
        if seen[x] > cnt:
            best, cnt = x, seen[x]
    return best


def _var(v, ddof):
    v = [x for x in _need(v, "variance")]
    if len(v) - ddof <= 0:
        raise CalcError("not enough values for that variance (need at least %d)" % (ddof + 1))
    m = _divx(_sum(v), len(v))
    return _divx(sum((x - m) * (x - m) for x in v), len(v) - ddof)


def _variance(*a): return _var(_vals(a), 1)
def _pvariance(*a): return _var(_vals(a), 0)
def _stdev(*a): return math.sqrt(_flt(_var(_vals(a), 1)))
def _pstdev(*a): return math.sqrt(_flt(_var(_vals(a), 0)))


def _percentile(data, p):
    v = sorted(_need(_flat([data]), "percentile"))
    p = _flt(p)
    if not 0 <= p <= 100:
        raise CalcError("percentile p must be 0..100")
    k = (len(v) - 1) * p / 100
    f = int(math.floor(k))
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def _cov(x, y):
    x, y = _flat([x]), _flat([y])
    if len(x) != len(y) or len(x) < 2:
        raise CalcError("cov/corr need two lists of equal length (at least 2)")
    mx, my = sum(x) / len(x), sum(y) / len(y)
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (len(x) - 1)


def _corr(x, y):
    sx, sy = _stdev(x), _stdev(y)
    if sx == 0 or sy == 0:
        raise CalcError("correlation undefined: a list has zero variance")
    return _flt(_cov(x, y)) / (sx * sy)


def _linfit(x, y):
    """Least-squares line: [slope, intercept, r_squared]."""
    x, y = _flat([x]), _flat([y])
    if len(x) != len(y) or len(x) < 2:
        raise CalcError("linfit needs two lists of equal length (at least 2)")
    mx, my = sum(x) / len(x), sum(y) / len(y)
    sxx = sum((a - mx) ** 2 for a in x)
    if sxx == 0:
        raise CalcError("linfit: all x values are equal")
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    slope = sxy / sxx
    syy = sum((b - my) ** 2 for b in y)
    return [slope, my - slope * mx, (sxy * sxy / (sxx * syy)) if syy else 1.0]


def _check_matrix(m, square=False):
    if not (isinstance(m, list) and m and all(isinstance(r, list) and r for r in m)):
        raise CalcError("expected a matrix like [[1,2],[3,4]]")
    w = len(m[0])
    if any(len(r) != w for r in m):
        raise CalcError("matrix rows must all have the same length")
    if len(m) > MAX_MATRIX or w > MAX_MATRIX:
        raise CalcError("matrix too large (max %dx%d)" % (MAX_MATRIX, MAX_MATRIX))
    for r in m:
        for x in r:
            if not _isnum(x):
                raise CalcError("matrix entries must be numbers")
    if square and len(m) != w:
        raise CalcError("expected a square matrix")
    return m


def _exactify(m):
    """Fractions if every entry is exact (int / Fraction), else None."""
    if all(isinstance(x, (int, Fraction)) for r in m for x in r):
        return [[Fraction(x) for x in r] for r in m]
    return None


def matmul(a, b):
    if a and not isinstance(a[0], list) and b and not isinstance(b[0], list):
        return _dot(a, b)
    if a and not isinstance(a[0], list):
        a = [a]
    if b and not isinstance(b[0], list):
        b = [[x] for x in b]
    _check_matrix(a), _check_matrix(b)
    if len(a[0]) != len(b):
        raise CalcError("matmul: shapes %dx%d and %dx%d do not match" % (len(a), len(a[0]), len(b), len(b[0])))
    bt = list(zip(*b))
    return [[sum(x * y for x, y in zip(r, c)) for c in bt] for r in a]


def transpose(m):
    if m and not isinstance(m[0], list):
        return [[x] for x in m]
    return [list(r) for r in zip(*_check_matrix(m))]


def identity(n):
    n = _int(n)
    if not 1 <= n <= MAX_MATRIX:
        raise CalcError("identity size must be 1..%d" % MAX_MATRIX)
    return [[1 if i == j else 0 for j in range(n)] for i in range(n)]


def trace(m):
    _check_matrix(m, True)
    return sum(m[i][i] for i in range(len(m)))


def _eliminate(m, aug=None):
    """Gauss-Jordan on a copy. Returns (reduced matrix, reduced augment, rank, det_sign_product, pivots)."""
    ex = _exactify(m)
    use = ex is not None and (aug is None or _exactify(aug) is not None)
    if use:
        a = ex
        b = _exactify(aug) if aug is not None else None
    else:
        a = [[complex(x) if isinstance(x, complex) else float(x) for x in r] for r in m]
        b = [[complex(x) if isinstance(x, complex) else float(x) for x in r] for r in aug] if aug is not None else None
    n, w = len(a), len(a[0])
    det, rank, row = 1, 0, 0
    eps = 0 if use else 1e-12
    for col in range(w):
        if row >= n:
            break
        piv = max(range(row, n), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) <= eps:
            det = 0
            continue
        if piv != row:
            a[row], a[piv] = a[piv], a[row]
            if b:
                b[row], b[piv] = b[piv], b[row]
            det = -det
        pv = a[row][col]
        det = det * pv
        a[row] = [x / pv for x in a[row]]
        if b:
            b[row] = [x / pv for x in b[row]]
        for r in range(n):
            if r != row and a[r][col] != 0:
                f = a[r][col]
                a[r] = [x - f * y for x, y in zip(a[r], a[row])]
                if b:
                    b[r] = [x - f * y for x, y in zip(b[r], b[row])]
        row += 1
        rank += 1
    return a, b, rank, det


def det(m):
    _check_matrix(m, True)
    _, _, rank, d = _eliminate(m)
    if rank < len(m):
        return 0
    return _norm_out(d)


def rank(m):
    return _eliminate(_check_matrix(m))[2]


def inv(m):
    _check_matrix(m, True)
    n = len(m)
    _, b, r, _d = _eliminate(m, identity(n))
    if r < n:
        raise CalcError("matrix is singular (no inverse)")
    return [[_norm_out(x) for x in row] for row in b]


def solve_linear(a, b):
    """Solve A x = b (b a vector or a matrix of columns)."""
    _check_matrix(a, True)
    vec = not isinstance(b[0], list) if b else False
    bm = [[x] for x in b] if vec else b
    if len(bm) != len(a):
        raise CalcError("solve_linear: b must have %d rows" % len(a))
    _, sol, r, _d = _eliminate(a, bm)
    if r < len(a):
        raise CalcError("matrix is singular: no unique solution")
    out = [[_norm_out(x) for x in row] for row in sol]
    return [row[0] for row in out] if vec else out


def _dot(a, b):
    a, b = _flat([a]), _flat([b])
    if len(a) != len(b):
        raise CalcError("dot: vectors must have the same length")
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    a, b = _flat([a]), _flat([b])
    if len(a) != 3 or len(b) != 3:
        raise CalcError("cross: vectors must have 3 components")
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _norm(v, p=2):
    v = _flat([v])
    p = _flt(p)
    if p == INF:
        return max(abs(x) for x in v)
    return sum(abs(x) ** p for x in v) ** (1 / p) if p != 2 else math.sqrt(sum(abs(x) ** 2 for x in v))


def polyroots(coeffs):
    """All complex roots of c0*x^n + ... + cn (highest power first) by Durand-Kerner iteration."""
    c = [complex(x) for x in _flat([coeffs])]
    while c and c[0] == 0:
        c.pop(0)
    n = len(c) - 1
    if n < 1:
        raise CalcError("polyroots needs a polynomial of degree >= 1")
    if n > 40:
        raise CalcError("polyroots: degree limited to 40")
    c = [x / c[0] for x in c]
    bound = 1 + max(abs(x) for x in c[1:])
    roots = [complex(0.4, 0.9) ** k * bound * 0.5 for k in range(n)]
    for _ in range(2000):
        delta = 0.0
        for i in range(n):
            p = 0j
            for co in c:
                p = p * roots[i] + co
            d = 1 + 0j
            for j in range(n):
                if j != i:
                    d *= roots[i] - roots[j]
            if d == 0:
                d = 1e-12
            step = p / d
            roots[i] -= step
            delta = max(delta, abs(step))
        if delta < 1e-14 * bound:
            break
    out = []
    for r in roots:
        scale = max(1.0, abs(r))
        re_, im_ = r.real, r.imag
        if abs(im_) < 1e-9 * scale:
            im_ = 0.0
        if abs(re_) < 1e-9 * scale:
            re_ = 0.0
        out.append(re_ if im_ == 0 else complex(re_, im_))
    return sorted(out, key=lambda z: (round(z.real if isinstance(z, complex) else z, 9), z.imag if isinstance(z, complex) else 0))


def eigvals(m):
    """Eigenvalues via the characteristic polynomial (Faddeev-LeVerrier), then polyroots. Square, n <= 12."""
    _check_matrix(m, True)
    n = len(m)
    if n > 12:
        raise CalcError("eigvals: matrices up to 12x12")
    a = _exactify(m) or [[complex(x) if isinstance(x, complex) else float(x) for x in r] for r in m]
    one = Fraction(1) if _exactify(m) else 1.0
    coeffs = [one]
    ident = [[one if i == j else 0 * one for j in range(n)] for i in range(n)]
    ck = one
    mk = [[0 * one] * n for _ in range(n)]
    for k in range(1, n + 1):
        mk = [[sum(a[i][t] * mk[t][j] for t in range(n)) + ck * ident[i][j] for j in range(n)] for i in range(n)]
        am = [[sum(a[i][t] * mk[t][j] for t in range(n)) for j in range(n)] for i in range(n)]
        ck = -sum(am[i][i] for i in range(n)) / k
        coeffs.append(ck)
    return polyroots([complex(x) if not isinstance(x, complex) else x for x in coeffs])


# ------------------------------------------------------------------ real / complex elementary functions
def _wrap(real, cplx, name, domain=None):
    def f(x):
        if isinstance(x, complex):
            return cplx(x)
        x = _flt(x)
        try:
            if domain and not domain(x):
                return cplx(complex(x))
            return real(x)
        except OverflowError:
            raise CalcError("%s: result too large" % name)
        except ValueError:
            raise CalcError("%s: math domain error for %r" % (name, x))
    f.__name__ = name
    return f


def _sqrt(x):
    if isinstance(x, (int, Fraction)) and not isinstance(x, bool) and x >= 0:
        r = _exact_pow(Fraction(x), 1, 2)
        if r is not None:
            return _norm_out(r)
    if isinstance(x, complex):
        return cmath.sqrt(x)
    x = _flt(x)
    return math.sqrt(x) if x >= 0 else cmath.sqrt(x)


def _cbrt(x):
    if isinstance(x, (int, Fraction)) and not isinstance(x, bool):
        f = Fraction(x)
        r = _exact_pow(abs(f), 1, 3)
        if r is not None:
            return _norm_out(r if f >= 0 else -r)
    x = _flt(x)
    return math.copysign(abs(x) ** (1 / 3), x)


def _log(x, base=None):
    if base is not None:
        return _div(_log(x), _log(base))
    if isinstance(x, complex):
        if x == 0:
            raise CalcError("log(0) is undefined")
        return cmath.log(x)
    if isinstance(x, int) and x > 0 and x.bit_length() > 1000:
        return math.log(x)
    x = _flt(x)
    if x == 0:
        raise CalcError("log(0) is undefined")
    return math.log(x) if x > 0 else cmath.log(x)


def _div(a, b):
    if b == 0:
        raise CalcError("division by zero")
    return a / b


def _log10(x):
    return _div(_log(x), math.log(10))


def _log2(x):
    if isinstance(x, int) and x > 0:
        if x & (x - 1) == 0:
            return x.bit_length() - 1
        return math.log2(x)
    return _div(_log(x), math.log(2))


def _round(x, n=0):
    n = _int(n)
    if isinstance(x, complex):
        return complex(round(x.real, n), round(x.imag, n))
    if isinstance(x, Fraction):
        return round(x) if n == 0 else round(x, n)
    return round(_flt(x), n) if n else int(round(_flt(x)))


def _roundint(f):
    def g(x):
        if isinstance(x, int):
            return x
        if isinstance(x, Fraction):
            return f(x)
        return int(f(_flt(x)))
    return g


def _abs(x):
    return abs(x)


def _sign(x):
    if isinstance(x, complex):
        return x / abs(x) if x else 0
    return (x > 0) - (x < 0)


def _min(*a):
    return min(_need(_vals(a), "min"))


def _max(*a):
    return max(_need(_vals(a), "max"))


def _gamma(x):
    x = _flt(x)
    try:
        return math.gamma(x)
    except (ValueError, OverflowError):
        raise CalcError("gamma: undefined or too large for %r" % x)


def _lgamma(x):
    try:
        return math.lgamma(_flt(x))
    except (ValueError, OverflowError):
        raise CalcError("lgamma: undefined for that value")


def _atan2(y, x):
    return math.atan2(_flt(y), _flt(x))


def _hypot(*a):
    return math.hypot(*[_flt(x) for x in _vals(a)])


def _range(*a):
    a = [_int(x) for x in a]
    if len(a) == 1:
        a = [0, a[0], 1]
    elif len(a) == 2:
        a = [a[0], a[1], 1]
    if len(a) != 3 or a[2] == 0:
        raise CalcError("range(stop) / range(start, stop[, step])")
    r = range(*a)
    if len(r) > MAX_LIST:
        raise CalcError("range too long")
    return list(r)


def _linspace(a, b, n):
    a, b, n = _flt(a), _flt(b), _int(n)
    if not 1 <= n <= MAX_LIST:
        raise CalcError("linspace: n out of range")
    return [a] if n == 1 else [a + (b - a) * i / (n - 1) for i in range(n)]


def _len(x):
    if not isinstance(x, list):
        raise CalcError("len() needs a list")
    return len(x)


def _sorted(x, rev=False):
    if not isinstance(x, list):
        raise CalcError("sorted() needs a list")
    return sorted(x, reverse=bool(rev))


def _cum(x):
    out, s = [], 0
    for v in _flat([x]):
        s = s + v
        out.append(s)
    return out


def _polar(z):
    z = complex(z)
    return [abs(z), cmath.phase(z)]


def _rect(r, th):
    return cmath.rect(_flt(r), _flt(th))


def _re(z): return z.real if isinstance(z, complex) else z
def _im(z): return z.imag if isinstance(z, complex) else 0
def _conj(z): return z.conjugate() if isinstance(z, complex) else z
def _phase(z): return cmath.phase(complex(z))


def _deg(f):
    return lambda x: f(math.radians(_flt(x)))


def _ideg(f):
    return lambda x: math.degrees(f(x))


def _trig(name, real, cplx):
    return _wrap(real, cplx, name)


_ASIN = lambda x: math.asin(x) if -1 <= x <= 1 else cmath.asin(x)
_ACOS = lambda x: math.acos(x) if -1 <= x <= 1 else cmath.acos(x)
_ACOSH = lambda x: math.acosh(x) if x >= 1 else cmath.acosh(x)
_ATANH = lambda x: math.atanh(x) if -1 < x < 1 else cmath.atanh(x)


def _tan(x):
    if not isinstance(x, complex):
        x = _flt(x)
        if abs(math.cos(x)) < 1e-15:
            raise CalcError("tan is undefined (pole) at that value")
        return math.tan(x)
    return cmath.tan(x)


FUNCS = {
    # elementary
    "sqrt": _sqrt, "cbrt": _cbrt,
    "exp": _wrap(math.exp, cmath.exp, "exp"),
    "ln": _log, "log": _log, "log10": _log10, "log2": _log2,
    "sin": _wrap(math.sin, cmath.sin, "sin"), "cos": _wrap(math.cos, cmath.cos, "cos"), "tan": _tan,
    "asin": _wrap(_ASIN, cmath.asin, "asin"), "acos": _wrap(_ACOS, cmath.acos, "acos"),
    "atan": _wrap(math.atan, cmath.atan, "atan"), "atan2": _atan2,
    "sinh": _wrap(math.sinh, cmath.sinh, "sinh"), "cosh": _wrap(math.cosh, cmath.cosh, "cosh"),
    "tanh": _wrap(math.tanh, cmath.tanh, "tanh"), "asinh": _wrap(math.asinh, cmath.asinh, "asinh"),
    "acosh": _wrap(_ACOSH, cmath.acosh, "acosh"), "atanh": _wrap(_ATANH, cmath.atanh, "atanh"),
    "sind": _deg(math.sin), "cosd": _deg(math.cos), "tand": _deg(math.tan),
    "asind": _ideg(_ASIN), "acosd": _ideg(_ACOS), "atand": _ideg(math.atan),
    "degrees": lambda x: math.degrees(_flt(x)), "radians": lambda x: math.radians(_flt(x)),
    "floor": _roundint(math.floor), "ceil": _roundint(math.ceil), "trunc": _roundint(math.trunc),
    "round": _round, "abs": _abs, "sign": _sign, "hypot": _hypot,
    "gamma": _gamma, "lgamma": _lgamma, "erf": lambda x: math.erf(_flt(x)), "erfc": lambda x: math.erfc(_flt(x)),
    "isqrt": lambda n: math.isqrt(_int(n)),
    "min": _min, "max": _max, "sum": _sum, "prod": _prod, "fsum": lambda *a: math.fsum(_flt(x) for x in _vals(a)),
    "float": lambda x: _flt(x), "int": lambda x: int(_flt(x)),
    "frac": lambda a, b=1: Fraction(_int(a), _int(b)) if _int(b) else _div(1, 0),
    # complex
    "re": _re, "im": _im, "conj": _conj, "phase": _phase, "arg": _phase, "polar": _polar, "rect": _rect,
    # combinatorics / number theory
    "factorial": _factorial, "comb": _comb, "perm": _perm, "binomial": _comb, "nCr": _comb, "nPr": _perm,
    "gcd": _gcd, "lcm": _lcm, "fib": fib, "isprime": isprime, "nextprime": nextprime, "prevprime": prevprime,
    "factor": factor, "divisors": divisors, "totient": totient, "pow": _pow3, "modpow": _pow3, "modinv": _modinv,
    "tobase": tobase, "int_from": lambda s, b=10: int(str(s), _int(b)),
    # lists & statistics
    "len": _len, "range": _range, "linspace": _linspace, "sorted": _sorted, "cumsum": _cum,
    "mean": _mean, "average": _mean, "median": _median, "mode": _mode, "variance": _variance, "pvariance": _pvariance,
    "stdev": _stdev, "pstdev": _pstdev, "percentile": _percentile, "cov": _cov, "corr": _corr, "linfit": _linfit,
    "list": lambda x: list(x) if isinstance(x, list) else [x],
    # vectors, matrices, polynomials
    "dot": _dot, "cross": _cross, "norm": _norm, "matmul": matmul, "transpose": transpose, "identity": identity,
    "eye": identity, "det": det, "inv": inv, "rank": rank, "trace": trace, "solve_linear": solve_linear,
    "eigvals": eigvals, "polyroots": polyroots,
}

CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau, "inf": INF, "nan": float("nan"),
          "phi": (1 + 5 ** 0.5) / 2, "true": True, "false": False, "True": True, "False": False,
          "euler_gamma": 0.5772156649015329}

# functions that take an expression *string* and evaluate it repeatedly (handled inside the evaluator)
SPECIAL = ("diff", "integrate", "solve", "limit", "sumto", "prodto")

HELP_NAMES = sorted(set(FUNCS) | set(SPECIAL))

# ------------------------------------------------------------------ numeric calculus
_XGK = (0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
        0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
        0.586087235467691130294144838258730, 0.405845151377397166906606412076961,
        0.207784955007898467600689403773245, 0.0)
_WGK = (0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
        0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
        0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
        0.204432940075298892414161999234649, 0.209482141084727828012999174891714)
_WG = (0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
       0.381830050505118944950369775488975, 0.417959183673469387755102040816327)


def _gk15(f, a, b):
    c, h = 0.5 * (a + b), 0.5 * (b - a)
    fc = f(c)
    resk = fc * _WGK[7]
    resg = fc * _WG[3]
    for j in range(7):
        x = h * _XGK[j]
        f1, f2 = f(c - x), f(c + x)
        resk += _WGK[j] * (f1 + f2)
        if j % 2 == 1:
            resg += _WG[j // 2] * (f1 + f2)
    return resk * h, abs((resk - resg) * h)


def _integrate(f, a, b, tol=1e-11):
    if a == b:
        return 0.0, 0.0
    sign = 1.0
    if a > b:
        a, b, sign = b, a, -1.0
    g = f
    if a == -INF and b == INF:
        g = lambda t: f(t / (1 - t * t)) * (1 + t * t) / (1 - t * t) ** 2
        a, b = -1.0, 1.0
    elif b == INF:
        aa = a
        g = lambda t: f(aa + t / (1 - t)) / (1 - t) ** 2
        a, b = 0.0, 1.0
    elif a == -INF:
        bb = b
        g = lambda t: f(bb - (1 - t) / t) / (t * t)
        a, b = 0.0, 1.0
    if a == -INF or b == INF:
        raise CalcError("integrate: bad limits")
    # nudge endpoints off singular transforms by never evaluating exactly at the ends (GK nodes are interior)
    heap, total, err, n = [], 0.0, 0.0, 0
    v, e = _gk15(g, a, b)
    heapq.heappush(heap, (-e, a, b, v))
    total, err = v, e
    while heap and err > max(tol * abs(total), 1e-14) and n < 600:
        ne, lo, hi, v0 = heapq.heappop(heap)
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            heapq.heappush(heap, (ne, lo, hi, v0))
            break
        v1, e1 = _gk15(g, lo, mid)
        v2, e2 = _gk15(g, mid, hi)
        total += v1 + v2 - v0
        err += e1 + e2 + ne
        heapq.heappush(heap, (-e1, lo, mid, v1))
        heapq.heappush(heap, (-e2, mid, hi, v2))
        n += 1
    total = sum(h[3] for h in heap)
    err = sum(-h[0] for h in heap)
    return sign * total, err


def _ridders(f, x, h, order_1=True):
    """Derivative by Ridders' extrapolation. Returns (value, error estimate)."""
    CON, CON2, NTAB, SAFE = 1.4, 1.96, 10, 2.0
    a = [[0.0] * NTAB for _ in range(NTAB)]
    a[0][0] = (f(x + h) - f(x - h)) / (2 * h)
    err = 1e300
    ans = a[0][0]
    for i in range(1, NTAB):
        h /= CON
        a[0][i] = (f(x + h) - f(x - h)) / (2 * h)
        fac = CON2
        for j in range(1, i + 1):
            a[j][i] = (a[j - 1][i] * fac - a[j - 1][i - 1]) / (fac - 1)
            fac *= CON2
            errt = max(abs(a[j][i] - a[j - 1][i]), abs(a[j][i] - a[j - 1][i - 1]))
            if errt <= err:
                err, ans = errt, a[j][i]
        if abs(a[i][i] - a[i - 1][i - 1]) >= SAFE * err:
            break
    return ans, err


def _derivative(f, x0, order=1):
    order = _int(order)
    if not 1 <= order <= 3:
        raise CalcError("diff: order must be 1, 2 or 3")
    x0 = float(x0)
    last = None
    for shrink in (1.0, 0.1, 0.01, 0.001):          # smaller steps if f is undefined too far from x0
        h = max(abs(x0), 1.0) * 0.05 * shrink
        try:
            if order == 1:
                return _ridders(f, x0, h)
            if order == 2:
                return _ridders(lambda t: _ridders(f, t, h * 0.5)[0], x0, h)
            return _ridders(lambda t: _ridders(lambda u: _ridders(f, u, h * 0.5)[0], t, h * 0.5)[0], x0, h)
        except CalcError as e:
            last = e
    raise last


def _find_root(f, a, b, fa, fb):
    for _ in range(200):
        m = 0.5 * (a + b)
        fm = f(m)
        if fm == 0 or (b - a) < 1e-15 * max(1.0, abs(m)):
            return m
        if (fa < 0) == (fm < 0):
            a, fa = m, fm
        else:
            b, fb = m, fm
    return 0.5 * (a + b)


class _Ev:
    def __init__(self, exact=False, variables=None):
        self.exact = exact
        self.ops = 0
        self._chk = 0
        self.t0 = time.monotonic()
        self.env = dict(variables or {})
        self.notes = []
        self._cache = {}

    # -- guards
    def tick(self, n=1):
        self.ops += n
        if self.ops > MAX_OPS:
            raise CalcError("calculation too large (over %d steps) - simplify it or split it up" % MAX_OPS)
        if self.ops - self._chk >= 256:
            self._chk = self.ops
            if time.monotonic() - self.t0 > MAX_SECONDS:
                raise CalcError("calculation took longer than %g s" % MAX_SECONDS)

    # -- parsing
    def compile(self, text):
        text = _prep(text)
        if text not in self._cache:
            try:
                self._cache[text] = ast.parse(text, mode="eval").body
            except SyntaxError as e:
                raise CalcError("syntax error in '%s': %s" % (text, e.msg))
        return self._cache[text]

    # -- evaluation
    def ev(self, n, env):
        self.tick()
        t = type(n)
        if t is ast.Constant:
            return self.const(n.value)
        if t is ast.Name:
            if n.id in env:
                return env[n.id]
            if n.id in CONSTS:
                return CONSTS[n.id]
            if n.id in FUNCS or n.id in SPECIAL:
                raise CalcError("'%s' is a function - call it like %s(...)" % (n.id, n.id))
            raise CalcError("unknown name '%s'%s" % (n.id, _suggest(n.id, list(env) + list(CONSTS) + HELP_NAMES)))
        if t is ast.BinOp:
            return self.binop(type(n.op), self.ev(n.left, env), self.ev(n.right, env))
        if t is ast.UnaryOp:
            v = self.ev(n.operand, env)
            if isinstance(n.op, ast.Not):
                return not v
            if isinstance(v, list):
                if isinstance(n.op, ast.USub):
                    return [self.unary_neg(x) for x in v]
                return v
            if not _isnum(v):
                raise CalcError("cannot apply a sign to that")
            if isinstance(n.op, ast.USub):
                return -v
            if isinstance(n.op, ast.UAdd):
                return v
            raise CalcError("unsupported operator")
        if t is ast.Call:
            return self.call(n, env)
        if t in (ast.List, ast.Tuple):
            if len(n.elts) > MAX_LIST:
                raise CalcError("list too long")
            return [self.ev(e, env) for e in n.elts]
        if t is ast.Subscript:
            return self.subscript(n, env)
        if t is ast.Compare:
            left = self.ev(n.left, env)
            for op, rn in zip(n.ops, n.comparators):
                right = self.ev(rn, env)
                try:
                    ok = {ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b, ast.Lt: lambda a, b: a < b,
                          ast.LtE: lambda a, b: a <= b, ast.Gt: lambda a, b: a > b,
                          ast.GtE: lambda a, b: a >= b}[type(op)](left, right)
                except KeyError:
                    raise CalcError("unsupported comparison")
                except TypeError:
                    raise CalcError("cannot order those values (complex numbers have no order)")
                if not ok:
                    return False
                left = right
            return True
        if t is ast.BoolOp:
            if isinstance(n.op, ast.And):
                v = True
                for x in n.values:
                    v = self.ev(x, env)
                    if not v:
                        return v
                return v
            v = False
            for x in n.values:
                v = self.ev(x, env)
                if v:
                    return v
            return v
        if t is ast.IfExp:
            return self.ev(n.body if self.ev(n.test, env) else n.orelse, env)
        if t in (ast.ListComp, ast.GeneratorExp):
            return self.comp(n, env)
        raise CalcError("unsupported syntax (%s) - only maths expressions are allowed" % t.__name__)

    def comp(self, n, env):
        if len(n.generators) != 1:
            raise CalcError("only one 'for' is supported in a list comprehension")
        g = n.generators[0]
        if not isinstance(g.target, ast.Name):
            raise CalcError("comprehension variable must be a plain name")
        seq = self.ev(g.iter, env)
        if not isinstance(seq, list):
            raise CalcError("can only loop over a list or range(...)")
        out, sub = [], dict(env)
        for item in seq:
            self.tick()
            sub[g.target.id] = item
            if all(self.ev(c, sub) for c in g.ifs):
                out.append(self.ev(n.elt, sub))
        return out

    def subscript(self, n, env):
        v = self.ev(n.value, env)
        sl = n.slice
        if hasattr(ast, "Index") and isinstance(sl, getattr(ast, "Index")):
            sl = sl.value
        if not isinstance(v, list):
            raise CalcError("only lists can be indexed")
        try:
            if isinstance(sl, ast.Slice):
                f = lambda x: None if x is None else _int(self.ev(x, env))
                return v[f(sl.lower):f(sl.upper):f(sl.step)]
            return v[_int(self.ev(sl, env))]
        except IndexError:
            raise CalcError("list index out of range")

    def const(self, v):
        if isinstance(v, bool):
            return v
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            if self.exact and v == v and abs(v) != INF:
                return Fraction(repr(v))
            return v
        if isinstance(v, (complex, str)):
            return v
        raise CalcError("unsupported value")

    def unary_neg(self, x):
        return [self.unary_neg(i) for i in x] if isinstance(x, list) else -x

    def binop(self, op, a, b):
        if isinstance(a, str) or isinstance(b, str):
            raise CalcError("text cannot be used in arithmetic")
        if op is ast.MatMult:
            if not (isinstance(a, list) and isinstance(b, list)):
                raise CalcError("@ needs two matrices / vectors")
            return matmul(a, b)
        if isinstance(a, list) or isinstance(b, list):
            return self.vec(op, a, b)
        if isinstance(a, bool):
            a = int(a)
        if isinstance(b, bool):
            b = int(b)
        try:
            if op is ast.Add:
                return a + b
            if op is ast.Sub:
                return a - b
            if op is ast.Mult:
                if isinstance(a, int) and isinstance(b, int) and a.bit_length() + b.bit_length() > MAX_BITS:
                    raise CalcError("result would be astronomically large")
                return a * b
            if op is ast.Div:
                if b == 0:
                    raise CalcError("division by zero")
                if isinstance(a, (int, Fraction)) and isinstance(b, (int, Fraction)):
                    q = Fraction(a) / Fraction(b)
                    if self.exact:
                        return q
                    return a / b if isinstance(a, int) and isinstance(b, int) and max(abs(a), abs(b)).bit_length() < 1000 else float(q)
                return a / b
            if op is ast.FloorDiv:
                if b == 0:
                    raise CalcError("division by zero")
                return a // b
            if op is ast.Mod:
                if b == 0:
                    raise CalcError("modulo by zero")
                return a % b
            if op is ast.Pow:
                return self.power(a, b)
        except TypeError:
            raise CalcError("that operation is not defined for complex numbers (use real values)")
        except OverflowError:
            raise CalcError("result too large")
        raise CalcError("unsupported operator")

    def vec(self, op, a, b):
        if isinstance(a, list) and isinstance(b, list):
            if op in (ast.Add, ast.Sub):
                if len(a) != len(b):
                    raise CalcError("lists must have the same length")
                return [self.binop(op, x, y) for x, y in zip(a, b)]
            if op is ast.Mult:
                if len(a) != len(b):
                    raise CalcError("lists must have the same length")
                return [self.binop(op, x, y) for x, y in zip(a, b)]
            raise CalcError("for two lists use + - (elementwise), * (elementwise) or @ (matrix product)")
        if op in (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.FloorDiv, ast.Mod):
            if isinstance(a, list):
                if len(a) > MAX_LIST:
                    raise CalcError("list too long")
                return [self.binop(op, x, b) for x in a]
            return [self.binop(op, a, y) for y in b]
        raise CalcError("unsupported list operation")

    def power(self, a, b):
        if isinstance(a, list) or isinstance(b, list):
            raise CalcError("^ on lists is not supported")
        ai = isinstance(a, (int, Fraction))
        if ai and isinstance(b, (int, Fraction)):
            fb = Fraction(b)
            if fb.denominator == 1:
                e = int(fb)
                base = Fraction(a)
                bits = max(base.numerator.bit_length(), base.denominator.bit_length())
                if bits * abs(e) > MAX_BITS:
                    raise CalcError("result would be astronomically large")
                if base == 0 and e < 0:
                    raise CalcError("division by zero")
                if isinstance(a, int) and e >= 0:
                    return a ** e
                if self.exact:
                    return _norm_out(base ** e) if isinstance(a, Fraction) or e < 0 else a ** e
                return float(base ** e)
            if self.exact:
                r = _exact_pow(Fraction(a), fb.numerator, fb.denominator)
                if r is not None:
                    return _norm_out(r)
            b = float(fb)
        try:
            if isinstance(a, complex) or isinstance(b, complex):
                if a == 0:
                    if b == 0:
                        return 1
                    return 0
                return complex(a) ** complex(b)
            fa, fb2 = _flt(a), _flt(b)
            if fa < 0 and fb2 != int(fb2):
                return complex(fa) ** fb2
            if fa == 0 and fb2 < 0:
                raise CalcError("division by zero")
            return fa ** fb2
        except OverflowError:
            raise CalcError("result too large")
        except ZeroDivisionError:
            raise CalcError("division by zero")

    # -- calls
    def call(self, n, env):
        if not isinstance(n.func, ast.Name):
            raise CalcError("only plain function names can be called")
        name = n.func.id
        if any(isinstance(x, ast.Starred) for x in n.args):
            raise CalcError("* arguments are not supported")
        args = [self.ev(a, env) for a in n.args]
        kw = {k.arg: self.ev(k.value, env) for k in n.keywords if k.arg}
        if name in SPECIAL:
            return self.special(name, args, kw, env)
        fn = FUNCS.get(name)
        if fn is None:
            raise CalcError("unknown function '%s'%s" % (name, _suggest(name, HELP_NAMES)))
        if kw:
            if name in ("round", "log", "sorted", "perm", "tobase", "norm") :
                names = {"round": ("n",), "log": ("base",), "sorted": ("rev",), "perm": ("k",), "tobase": ("base",), "norm": ("p",)}[name]
                args += [kw[k] for k in names if k in kw]
            else:
                raise CalcError("%s() does not take keyword arguments" % name)
        self.tick(4)
        try:
            return fn(*args)
        except CalcError:
            raise
        except TypeError as e:
            raise CalcError("%s: wrong arguments (%s)" % (name, e))
        except (ValueError, OverflowError, ZeroDivisionError, ArithmeticError) as e:
            raise CalcError("%s: %s" % (name, e))

    def fx(self, expr, var, env):
        if not isinstance(expr, str):
            raise CalcError("the first argument must be an expression in quotes, e.g. diff('x**2', 3)")
        tree = self.compile(expr)
        sub = dict(env)

        def f(x):
            sub[var] = x
            return _flt(self.ev(tree, sub))
        return f

    def special(self, name, args, kw, env):
        var = kw.pop("var", "x")
        if not isinstance(var, str):
            raise CalcError("var must be a name in quotes")
        if name == "diff":
            if len(args) < 2:
                raise CalcError("diff('expr', x0 [, order])")
            order = args[2] if len(args) > 2 else kw.get("order", 1)
            f = self.fx(args[0], var, env)
            val, err = _derivative(f, _flt(args[1]), order)
            self.notes.append("diff is numerical (Ridders), estimated error about %.1e" % err)
            return val
        if name == "integrate":
            if len(args) < 3:
                raise CalcError("integrate('expr', a, b)   (a and b may be -inf / inf)")
            f = self.fx(args[0], var, env)
            val, err = _integrate(f, _flt(args[1]), _flt(args[2]))
            self.notes.append("integrate is numerical (adaptive Gauss-Kronrod), estimated error about %.1e" % err)
            return val
        if name == "solve":
            if len(args) < 2:
                raise CalcError("solve('expr', guess)  or  solve('expr', lo, hi)   (finds f(x) = 0; write 'a - b' for a = b)")
            f = self.fx(args[0], var, env)
            if len(args) == 2:
                return self._newton(f, _flt(args[1]))
            return self._scan(f, _flt(args[1]), _flt(args[2]))
        if name == "limit":
            if len(args) < 2:
                raise CalcError("limit('expr', x0)   (x0 may be inf / -inf)")
            return self._limit(self.fx(args[0], var, env), _flt(args[1]))
        if name in ("sumto", "prodto"):
            if len(args) < 4 or not isinstance(args[1], str):
                raise CalcError("%s('expr', 'n', a, b)" % name)
            return self._series(name == "sumto", args[0], args[1], args[2], args[3], env)
        raise CalcError("unsupported")

    def _newton(self, f, x):
        for _ in range(100):
            fx = f(x)
            if fx == 0:
                return x
            d, _e = _ridders(f, x, max(abs(x), 1.0) * 1e-3)
            if d == 0:
                raise CalcError("solve: derivative is zero near %g - try a different guess or give a range" % x)
            nx = x - fx / d
            if abs(nx - x) <= 1e-14 * max(1.0, abs(nx)):
                self.notes.append("root found by Newton's method from the given guess (other roots may exist)")
                return nx
            x = nx
        raise CalcError("solve: did not converge - try another guess or give a range solve('expr', lo, hi)")

    def _scan(self, f, lo, hi):
        if not lo < hi or hi - lo == INF:
            raise CalcError("solve: need finite lo < hi")
        N = 4000
        xs = [lo + (hi - lo) * i / N for i in range(N + 1)]
        ys = []
        for x in xs:
            try:
                ys.append(f(x))
            except CalcError:
                ys.append(None)
        roots = []
        for i in range(N):
            a, b, fa, fb = xs[i], xs[i + 1], ys[i], ys[i + 1]
            if fa is None or fb is None:
                continue
            if fa == 0:
                roots.append(a)
            elif fa * fb < 0:
                r = _find_root(f, a, b, fa, fb)
                scale = max(abs(fa), abs(fb), 1.0)
                if abs(f(r)) <= 1e-6 * scale:
                    roots.append(r)
        if ys[-1] == 0:
            roots.append(hi)
        out = []
        for r in roots:
            if not out or abs(r - out[-1]) > 1e-9 * max(1.0, abs(r)):
                out.append(r)
        self.notes.append("scanned %d points; roots that only touch zero without crossing it can be missed" % N)
        return out if len(out) != 1 else out[0]

    def _limit(self, f, x0):
        def side(points):
            vals = []
            for p in points:
                try:
                    vals.append(f(p))
                except (CalcError, ArithmeticError):
                    pass
            if len(vals) < 2:
                raise CalcError("limit: the expression could not be evaluated near that point")
            last, prev = vals[-1], vals[-2]
            if abs(last) > 1e6 and abs(last) > 2 * abs(prev):
                return math.copysign(INF, last)
            if abs(last - prev) <= 1e-3 * max(1.0, abs(last)):
                return last
            raise CalcError("limit: values did not settle (last two: %.6g, %.6g)" % (prev, last))
        if abs(x0) == INF:
            sgn = math.copysign(1.0, x0)
            v = side([sgn * 1e3, sgn * 1e5, sgn * 1e7])
            self.notes.append("limit is numerical (evaluated at very large |x|)")
            return v if abs(v) == INF else float("%.10g" % v)
        lft = side([x0 - 1e-3, x0 - 1e-4, x0 - 1e-5])
        rgt = side([x0 + 1e-3, x0 + 1e-4, x0 + 1e-5])
        if abs(lft) == INF or abs(rgt) == INF:
            if lft == rgt:
                return lft
            raise CalcError("limit does not exist (the two sides diverge differently)")
        if abs(lft - rgt) > 1e-3 * max(1.0, abs(lft)):
            raise CalcError("limit does not exist (from the left %.6g, from the right %.6g)" % (lft, rgt))
        self.notes.append("limit is numerical (average of the left and right approach)")
        return float("%.10g" % (0.5 * (lft + rgt)))

    def _series(self, is_sum, expr, var, a, b, env):
        if not isinstance(expr, str):
            raise CalcError("first argument must be an expression in quotes")
        tree = self.compile(expr)
        sub = dict(env)
        acc = 0 if is_sum else 1
        a = _int(a, "start")
        if isinstance(b, float) and b == INF:
            if not is_sum:
                raise CalcError("prodto: infinite upper limit not supported")
            # partial sums at N, 2N, 4N terms, then Aitken extrapolation of the tail (handles 1/n^2 as well as
            # geometric and alternating series); terms that vanish quickly stop the loop early
            marks, S, small, k = (4096, 8192, 16384), [], 0, a
            for target in marks:
                while k < a + target:
                    sub[var] = k
                    t = self.ev(tree, sub)
                    acc = acc + t
                    self.tick()
                    if abs(t) <= 1e-17 * max(1.0, abs(acc)):
                        small += 1
                        if small >= 5:
                            self.notes.append("infinite series summed until its terms vanished (n up to %d)" % k)
                            return acc
                    else:
                        small = 0
                    k += 1
                S.append(acc)
            d1, d2 = S[1] - S[0], S[2] - S[1]
            if d2 == 0:
                return S[2]
            r = d1 / d2
            if r < 1.0 + 1e-2 and r > -1e6 and not (r < 0):
                raise CalcError("the series does not appear to converge")
            self.notes.append("infinite series: partial sums to %d terms with Aitken extrapolation of the tail" % (a + marks[-1]))
            return S[2] + d2 / (r - 1)
        b = _int(b, "end")
        if b - a > MAX_LIST:
            raise CalcError("too many terms")
        for k in range(a, b + 1):
            sub[var] = k
            t = self.ev(tree, sub)
            acc = acc + t if is_sum else acc * t
            self.tick()
        return acc


def _suggest(name, pool):
    m = difflib.get_close_matches(name, pool, n=2, cutoff=0.6)
    return " (did you mean %s?)" % " or ".join(m) if m else ""


def _prep(s):
    s = (s or "").strip()
    for a, b in (("×", "*"), ("·", "*"), ("÷", "/"), ("−", "-"), ("–", "-"), ("π", "pi"), ("√(", "sqrt("),
                 ("∞", "inf"), ("^", "**")):
        s = s.replace(a, b)
    s = re.sub(r"(?<![\w.)\]])(\d+)\s*!(?!=)", r"factorial(\1)", s)
    s = re.sub(r"(\b\d+(?:\.\d+)?)\s*%(?!\s*[\w(\d.])", r"(\1/100)", s)
    return s


# ------------------------------------------------------------------ formatting
def _fmt_int(n, limit=1000):
    neg = n < 0
    n = abs(n)
    if n.bit_length() > 200_000:
        return ("-" if neg else "") + "~10^%d (%d bits)" % (int(n.bit_length() * math.log10(2)), n.bit_length())
    try:
        import sys
        if hasattr(sys, "set_int_max_str_digits"):
            sys.set_int_max_str_digits(0)
    except Exception:
        pass
    s = str(n)
    if len(s) > limit:
        s = "%s...%s  (%d digits)" % (s[:40], s[-20:], len(s))
    return ("-" if neg else "") + s


def _fmt_f(x, prec):
    if x != x:
        return "nan"
    if x == INF:
        return "inf"
    if x == -INF:
        return "-inf"
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    return "%.*g" % (prec, x)


def _fmt_c(z, prec):
    re_, im_ = _fmt_f(z.real, prec), _fmt_f(abs(z.imag), prec)
    sgn = "-" if z.imag < 0 or (z.imag == 0 and math.copysign(1, z.imag) < 0) else "+"
    if z.imag == 0:
        return re_
    if z.real == 0:
        return ("-" if sgn == "-" else "") + (im_ if im_ != "1" else "") + "i"
    return "%s %s %s%si" % (re_, sgn, im_ if im_ != "1" else "", "")


def _frac_decimal(fr, digits):
    neg = fr < 0
    fr = abs(fr)
    ip, rem = divmod(fr.numerator, fr.denominator)
    out = []
    for _ in range(digits):
        rem *= 10
        d, rem = divmod(rem, fr.denominator)
        out.append(str(d))
    s = _fmt_int(ip, 10 ** 6) + "." + "".join(out)
    return ("-" if neg else "") + s


def fmt(v, prec=15):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return _fmt_int(v)
    if isinstance(v, Fraction):
        return _fmt_int(int(v)) if v.denominator == 1 else "%s/%s" % (_fmt_int(v.numerator), _fmt_int(v.denominator))
    if isinstance(v, float):
        return _fmt_f(v, prec)
    if isinstance(v, complex):
        return _fmt_c(v, prec)
    if isinstance(v, list):
        return "[" + ", ".join(fmt(x, prec) for x in v) + "]"
    if isinstance(v, str):
        return v
    return str(v)


def _factor_text(v):
    return " x ".join(("%s^%d" % (p, e) if e != 1 else str(p)) if not isinstance(p, str) else "%s: %s" % (p, e) for p, e in v)


def _is_factor_result(v):
    return isinstance(v, _Factors)


# ------------------------------------------------------------------ public entry point
def calculate(expression, exact=False, precision=15, variables=None):
    if not isinstance(expression, str) or not expression.strip():
        raise CalcError("expression is empty")
    if len(expression) > 5000:
        raise CalcError("expression too long")
    try:
        precision = int(precision or 15)
    except (TypeError, ValueError):
        precision = 15
    precision = max(1, min(precision, 60))
    ev = _Ev(bool(exact))
    _ctx.exact = bool(exact)
    # variables supplied by the caller
    if variables is not None:
        if not isinstance(variables, dict):
            raise CalcError("variables must be an object like {\"x\": 2, \"y\": 3}")
        for k, v in variables.items():
            if not re.fullmatch(r"[A-Za-z_]\w*", str(k)):
                raise CalcError("bad variable name %r" % (k,))
            if isinstance(v, str):
                v = ev.ev(ev.compile(v), {})
            elif isinstance(v, bool) or v is None:
                raise CalcError("variable %s must be a number" % k)
            elif isinstance(v, (int, float, list)):
                v = _from_json(v, ev)
            else:
                raise CalcError("variable %s must be a number, list or expression string" % k)
            ev.env[str(k)] = v
    try:
        src = _prep(expression)
        try:
            tree = ast.parse(src, mode="exec")
        except SyntaxError as e:
            raise CalcError("syntax error: %s%s" % (e.msg, " - use ** or ^ for powers, write 2*x rather than 2x, complex numbers as 3+4j, and factorial(n) instead of (n)!"))
        value, env = None, ev.env
        for st in tree.body:
            if isinstance(st, ast.Expr):
                value = ev.ev(st.value, env)
            elif isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                value = ev.ev(st.value, env)
                env[st.targets[0].id] = value
            else:
                raise CalcError("only expressions and simple assignments (a = 3) are allowed")
        if value is None:
            raise CalcError("nothing to calculate")
    except RecursionError:
        raise CalcError("expression is nested too deeply")
    except MemoryError:
        raise CalcError("out of memory")
    except (ZeroDivisionError, OverflowError) as e:
        raise CalcError("arithmetic error: %s" % e)
    out = {"expression": expression.strip()}
    if _is_factor_result(value):
        out["result"] = _factor_text(value)
        out["factors"] = [list(x) for x in value]
    elif isinstance(value, Fraction) and precision > 15 and value.denominator != 1:
        out["result"] = fmt(value)
        out["decimal"] = _frac_decimal(value, precision)
    else:
        out["result"] = fmt(value, min(precision, 17))
        if isinstance(value, Fraction):
            out["approx"] = _fmt_f(float(value), 15) if abs(value.numerator) < 10 ** 300 else "huge"
    if isinstance(value, (float, int, Fraction)) and not isinstance(value, bool):
        if isinstance(value, int) and abs(value).bit_length() > 50:
            out["digits"] = int(abs(value).bit_length() * math.log10(2)) + 1
    out["exact_mode"] = bool(exact)
    if ev.notes:
        out["note"] = "; ".join(dict.fromkeys(ev.notes))
    return out


def _from_json(v, ev):
    if isinstance(v, list):
        return [_from_json(x, ev) for x in v]
    if isinstance(v, bool):
        raise CalcError("booleans are not numbers")
    if isinstance(v, float) and ev.exact and v == v and abs(v) != INF:
        return Fraction(repr(v))
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return ev.ev(ev.compile(v), {})
    raise CalcError("unsupported variable value")
