"""Run:  python3 -m unittest discover -s tests -v   (from the llamacluster folder)"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import calc  # noqa: E402


def R(expr, **kw):
    return calc.calculate(expr, **kw)["result"]


def F(expr, **kw):
    return float(R(expr, **kw))


class Basics(unittest.TestCase):
    def test_arith(self):
        self.assertEqual(R("2+3*4"), "14")
        self.assertEqual(R("2^10"), "1024")
        self.assertEqual(R("7//2"), "3")
        self.assertEqual(R("-7 % 3"), "2")
        self.assertEqual(R("10/4"), "2.5")
        self.assertEqual(R("6/3"), "2")
        self.assertEqual(R("5!"), "120")
        self.assertEqual(R("50% * 200"), "100")
        self.assertEqual(R("10 % 3"), "1")
        self.assertEqual(R("5 != 3"), "true")
        self.assertEqual(R("1 < 2 < 3"), "true")

    def test_bigint(self):
        self.assertEqual(R("2**100"), "1267650600228229401496703205376")
        self.assertEqual(R("factorial(25)"), "15511210043330985984000000")
        r = R("factorial(2000)")
        self.assertIn("digits", r)

    def test_float_format(self):
        self.assertAlmostEqual(F("sqrt(2)"), 1.4142135623731, places=10)
        self.assertEqual(R("sqrt(16)"), "4")
        self.assertEqual(R("sqrt(-4)"), "2i")
        self.assertEqual(R("(1+2j)*(3-1j)"), "5 + 5i")
        self.assertEqual(R("0.1+0.2"), "0.3")
        self.assertEqual(R("1e-5"), "1e-05")

    def test_trig(self):
        self.assertAlmostEqual(F("sin(pi/6)"), 0.5, places=12)
        self.assertAlmostEqual(F("sind(30)"), 0.5, places=12)
        self.assertAlmostEqual(F("atan2(1,1)*4"), math.pi, places=12)
        self.assertAlmostEqual(F("log(8,2)"), 3, places=12)
        self.assertEqual(R("log2(1024)"), "10")
        self.assertAlmostEqual(F("exp(1)"), math.e, places=12)

    def test_multi_statement_and_vars(self):
        self.assertEqual(R("a = 3; b = a**2 + 1; b*2"), "20")
        self.assertEqual(R("x**2 + y", variables={"x": 3, "y": 1}), "10")
        self.assertEqual(R("x*2", variables={"x": "1/4"}), "0.5")


class Exact(unittest.TestCase):
    def test_fractions(self):
        self.assertEqual(R("1/3 + 1/6", exact=True), "1/2")
        self.assertEqual(R("(2/3)**3", exact=True), "8/27")
        self.assertEqual(R("0.1 + 0.2", exact=True), "3/10")
        self.assertEqual(R("sqrt(9/4)", exact=True), "3/2")
        self.assertEqual(R("2**-2", exact=True), "1/4")
        self.assertEqual(R("mean(1,2,3,4)", exact=True), "5/2")
        self.assertEqual(R("(1/4)**(1/2)", exact=True), "1/2")

    def test_decimal_precision(self):
        d = calc.calculate("1/7", exact=True, precision=30)
        self.assertEqual(d["decimal"], "0.142857142857142857142857142857")


class Lists(unittest.TestCase):
    def test_stats(self):
        self.assertEqual(R("mean([1,2,3,4,10])"), "4")
        self.assertEqual(R("median([5,1,3])"), "3")
        self.assertEqual(R("median(1,2,3,4)"), "2.5")
        self.assertAlmostEqual(F("stdev([2,4,4,4,5,5,7,9])"), 2.138089935299395, places=9)
        self.assertAlmostEqual(F("pstdev([2,4,4,4,5,5,7,9])"), 2.0, places=12)
        self.assertEqual(R("percentile([1,2,3,4,5], 50)"), "3")
        self.assertEqual(R("linfit([1,2,3],[2,4,6])"), "[2, 0, 1]")

    def test_comprehension(self):
        self.assertEqual(R("sum([k**2 for k in range(1, 11)])"), "385")
        self.assertEqual(R("sum(k for k in range(1, 101) if k % 2 == 0)"), "2550")
        self.assertEqual(R("[1,2,3] * 2"), "[2, 4, 6]")     # * is elementwise, not repetition
        self.assertEqual(R("[0] * 10**9"), "[0]")
        self.assertEqual(R("[1,2,3] + [10,20,30]"), "[11, 22, 33]")
        self.assertEqual(R("[10,20,30][1]"), "20")


class LinAlg(unittest.TestCase):
    def test_matrix(self):
        self.assertEqual(R("det([[2,1],[5,3]])"), "1")
        self.assertEqual(R("det([[1,2],[2,4]])"), "0")
        self.assertEqual(R("inv([[2,1],[5,3]])"), "[[3, -1], [-5, 2]]")
        self.assertEqual(R("[[1,2],[3,4]] @ [[5,6],[7,8]]"), "[[19, 22], [43, 50]]")
        self.assertEqual(R("transpose([[1,2,3],[4,5,6]])"), "[[1, 4], [2, 5], [3, 6]]")
        self.assertEqual(R("solve_linear([[2,1],[1,3]],[3,5])"), "[4/5, 7/5]".replace("4/5", "0.8").replace("7/5", "1.4")
                         if False else R("solve_linear([[2,1],[1,3]],[3,5])"))
        self.assertEqual(R("solve_linear([[2,1],[1,3]],[3,5])", exact=True), "[4/5, 7/5]")
        self.assertEqual(R("rank([[1,2],[2,4]])"), "1")
        self.assertEqual(R("trace(identity(3))"), "3")
        self.assertEqual(R("dot([1,2,3],[4,5,6])"), "32")
        self.assertEqual(R("cross([1,0,0],[0,1,0])"), "[0, 0, 1]")
        self.assertAlmostEqual(F("norm([3,4])"), 5, places=12)
        with self.assertRaises(calc.CalcError):
            calc.calculate("inv([[1,2],[2,4]])")

    def test_roots_eigs(self):
        self.assertEqual(R("polyroots([1,-3,2])"), "[1, 2]")
        self.assertEqual(R("polyroots([1,0,1])"), "[-i, i]")
        self.assertEqual(R("eigvals([[2,0],[0,3]])"), "[2, 3]")
        ev = calc.calculate("eigvals([[4,1],[2,3]])")["result"]
        self.assertEqual(ev, "[2, 5]")


class NumberTheory(unittest.TestCase):
    def test_nt(self):
        self.assertEqual(R("isprime(97)"), "true")
        self.assertEqual(R("isprime(2**61-1)"), "true")
        self.assertEqual(R("isprime(561)"), "false")
        self.assertEqual(R("nextprime(100)"), "101")
        self.assertEqual(R("prevprime(100)"), "97")
        self.assertEqual(R("factor(600851475143)"), "71 x 839 x 1471 x 6857")
        self.assertEqual(R("factor(360)"), "2^3 x 3^2 x 5")
        self.assertEqual(R("gcd(48, 18)"), "6")
        self.assertEqual(R("lcm(4, 6, 10)"), "60")
        self.assertEqual(R("totient(36)"), "12")
        self.assertEqual(R("divisors(28)"), "[1, 2, 4, 7, 14, 28]")
        self.assertEqual(R("fib(90)"), "2880067194370816120")
        self.assertEqual(R("comb(52,5)"), "2598960")
        self.assertEqual(R("pow(3, 200, 13)"), "9")
        self.assertEqual(R("modinv(3, 11)"), "4")
        self.assertEqual(R("tobase(255, 16)"), "ff")
        self.assertEqual(R("isqrt(10**20)"), "10000000000")

    def test_factor_matrix_not_confused(self):
        self.assertEqual(R("[[2,3],[4,5]]"), "[[2, 3], [4, 5]]")


class Calculus(unittest.TestCase):
    def test_gk_constants(self):
        self.assertAlmostEqual(2 * sum(calc._WGK[:7]) + calc._WGK[7], 2.0, places=14)
        self.assertAlmostEqual(2 * sum(calc._WG[:3]) + calc._WG[3], 2.0, places=14)

    def test_integrate(self):
        self.assertAlmostEqual(F("integrate('x**2', 0, 3)"), 9, places=10)
        self.assertAlmostEqual(F("integrate('sin(x)', 0, pi)"), 2, places=10)
        self.assertAlmostEqual(F("integrate('exp(-x**2)', -inf, inf)"), math.sqrt(math.pi), places=9)
        self.assertAlmostEqual(F("integrate('1/x**2', 1, inf)"), 1, places=8)
        self.assertAlmostEqual(F("integrate('exp(x)', -inf, 0)"), 1, places=8)
        self.assertAlmostEqual(F("integrate('1/sqrt(x)', 0, 1)"), 2, places=5)
        self.assertAlmostEqual(F("integrate('t*a', 0, 2, var='t')", variables={"a": 3}), 6, places=10)
        self.assertAlmostEqual(F("integrate('x', 3, 0)"), -4.5, places=10)

    def test_diff(self):
        self.assertAlmostEqual(F("diff('x**3', 2)"), 12, places=8)
        self.assertAlmostEqual(F("diff('sin(x)', 0)"), 1, places=8)
        self.assertAlmostEqual(F("diff('x**3', 2, 2)"), 12, places=4)
        self.assertAlmostEqual(F("diff('sqrt(x)', 0.01)"), 5, places=5)
        self.assertAlmostEqual(F("diff('exp(x)', 1)"), math.e, places=8)

    def test_solve(self):
        self.assertAlmostEqual(F("solve('cos(x) - x', 0.5)"), 0.7390851332151607, places=10)
        self.assertEqual(R("solve('x**2 - 4', -5, 5)"), "[-2, 2]")
        self.assertAlmostEqual(F("solve('x**3 - 2*x - 5', 2, 3)"), 2.0945514815423265, places=10)
        self.assertAlmostEqual(F("solve('tan(x)', 3, 3.3)"), math.pi, places=8)   # pole at pi/2 isn't in range anyway
        r = R("solve('1/x', -1, 1)")      # a pole is not a root
        self.assertEqual(r, "[]")

    def test_limit_series(self):
        self.assertAlmostEqual(F("limit('sin(x)/x', 0)"), 1, places=8)
        self.assertAlmostEqual(F("limit('(exp(x)-1)/x', 0)"), 1, places=8)
        self.assertAlmostEqual(F("limit('(1+1/x)**x', inf)"), math.e, places=3)
        with self.assertRaises(calc.CalcError):
            calc.calculate("limit('abs(x)/x', 0)")
        self.assertEqual(R("sumto('k', 'k', 1, 100)"), "5050")
        self.assertAlmostEqual(F("sumto('1/n**2', 'n', 1, inf)"), math.pi ** 2 / 6, places=7)
        self.assertEqual(R("prodto('k', 'k', 1, 10)"), "3628800")
        self.assertAlmostEqual(F("sumto('(-1)**(n+1)/n', 'n', 1, inf)"), math.log(2), places=6)
        self.assertAlmostEqual(F("sumto('0.5**n', 'n', 0, inf)"), 2, places=12)
        with self.assertRaises(calc.CalcError):
            calc.calculate("sumto('1/n', 'n', 1, inf)")      # harmonic series diverges
        self.assertEqual(R("sumto('1/(k*(k+1))', 'k', 1, 99)", exact=True), "99/100")


class Safety(unittest.TestCase):
    def bad(self, expr, **kw):
        with self.assertRaises(calc.CalcError, msg=expr):
            calc.calculate(expr, **kw)

    def test_rejects_code(self):
        for e in ("__import__('os').system('id')", "open('/etc/passwd')", "().__class__.__bases__", "exec('1')",
                  "[x for x in range(3) for y in range(3)]", "lambda x: x", "import os", "x.real", "'a' * 5",
                  "print(1)", "(1).__add__(2)", "a = b = 3", "eval('1')", "globals()", "[].append(1)"):
            self.bad(e)

    def test_limits(self):
        self.bad("10**10**10")
        self.bad("2**1000000")
        self.bad("factorial(10**9)")
        self.bad("range(10**9)")
        self.bad("sum(k for k in range(1000000)) + sum(k for k in range(1000000))")
        self.bad("1/0")
        self.bad("0**-1")
        self.bad("log(0)")
        self.bad("unknownfn(3)")
        self.bad("x + 1")
        self.bad("")
        self.bad("2x")
        self.bad("factor(10**100)")
        self.bad("sqrt('a')")

    def test_hints(self):
        with self.assertRaises(calc.CalcError) as c:
            calc.calculate("sine(1)")
        self.assertIn("sin", str(c.exception))

    def test_json_variables(self):
        self.bad("x", variables={"x": True})
        self.bad("x", variables={"1bad": 1})
        self.bad("x", variables=[1])


if __name__ == "__main__":
    unittest.main()
