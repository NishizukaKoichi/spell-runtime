"""Offline structural checks and a small safety model for the WIS design draft.

This is not a production runtime, payment adapter or a security certification.
No networking, real money, authentication or cryptographic verification occurs.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from threading import Lock
import unittest

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'schemas/wis.schema.json').read_text())
INDEX = json.loads((ROOT / 'examples/index.json').read_text())
EXAMPLES = {name: json.loads((ROOT / 'examples' / path).read_text())
            for name, path in INDEX.items()}


def check(name: str, value: dict) -> None:
    schema = {'$schema': SCHEMA['$schema'], '$defs': SCHEMA['$defs'],
              '$ref': f'#/$defs/{name}'}
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)


def resource_invariants(value: dict) -> None:
    check('UserResources', value)
    p = value['pocket_money']
    if p['available_minor'] != (p['deposited_minor'] + p['refunded_minor']
                                - p['spent_minor'] - p['reserved_minor']):
        raise ValueError('Pocket-money ledger is inconsistent')
    for e in value['energy_pools']:
        if e['available'] != e['granted'] - e['used'] - e['reserved']:
            raise ValueError('Energy ledger is inconsistent')


def quote_gate(quote: dict, *, now: datetime, currency: str,
               maximum_minor: int, permitted_effects: set[str]) -> None:
    """Only selected business invariants; no signature or identity checking."""
    check('Quote', quote)
    if quote['binding'] != 'firm':
        raise ValueError('An estimate is not a firm commitment')
    if datetime.fromisoformat(quote['expires_at'].replace('Z', '+00:00')) <= now:
        raise ValueError('Quote expired for new acceptance')
    if quote['all_in_max']['currency'] != currency:
        raise ValueError('Currency conversion was not authorized')
    if quote['all_in_max']['exponent'] != 2:
        raise ValueError('This AUD test model expects exponent 2')
    if quote['all_in_max']['minor_units'] > maximum_minor:
        raise ValueError('Spending authority insufficient')
    if not set(quote['effects']).issubset(permitted_effects):
        raise ValueError('An effect is outside the granted authority')


class AllowanceModel:
    """Single-process lock is a TEST MODEL, not a durable distributed ledger."""
    def __init__(self, deposited: int):
        if deposited < 0:
            raise ValueError('Negative deposit')
        self.deposited = deposited
        self.spent = 0
        self.holds: dict[str, int] = {}
        self.settled: dict[str, tuple[int, int]] = {}
        self.lock = Lock()

    @property
    def available(self) -> int:
        return self.deposited - self.spent - sum(self.holds.values())

    def reserve(self, key: str, amount: int) -> bool:
        with self.lock:
            if amount < 0:
                raise ValueError('Negative reservation')
            if key in self.settled:
                raise ValueError('A settled reservation cannot be reopened')
            if key in self.holds:
                if self.holds[key] != amount:
                    raise ValueError('Reservation idempotency conflict')
                return True
            if amount > self.available:
                return False
            self.holds[key] = amount
            return True

    def settle(self, key: str, charged: int) -> None:
        with self.lock:
            if key in self.settled:
                if self.settled[key][1] != charged:
                    raise ValueError('Settlement idempotency conflict')
                return
            held = self.holds[key]
            if charged < 0 or charged > held:
                raise ValueError('Charge exceeds reserved ceiling')
            self.spent += charged
            del self.holds[key]
            self.settled[key] = (held, charged)


class ExecutionModel:
    """In-memory idempotency illustration; deliberately NOT a real executor."""
    def __init__(self):
        self.records: dict[str, tuple[str, str]] = {}
        self.lock = Lock()

    def accept(self, request: dict, gate) -> str:
        check('ExecutionRequest', request)
        # Deterministic test key, NOT an implementation of JCS or a signature.
        canonical = json.dumps(request, sort_keys=True, separators=(',', ':'))
        key = request['operation_id']
        with self.lock:
            if key in self.records:
                old, execution_id = self.records[key]
                if old != canonical:
                    raise ValueError('Idempotency conflict')
                return execution_id
            gate()
            execution_id = f'execution-{len(self.records) + 1}'
            self.records[key] = canonical, execution_id
            return execution_id


class DraftChecks(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc)
        self.quote = deepcopy(EXAMPLES['Quote'])
        self.gate_args = dict(now=self.now, currency='AUD', maximum_minor=1200,
                              permitted_effects={'store_data', 'charge_money'})

    def test_schema_definitions(self):
        Draft202012Validator.check_schema(SCHEMA)
        for name, definition in SCHEMA['$defs'].items():
            with self.subTest(name=name):
                Draft202012Validator.check_schema(definition)

    def test_examples(self):
        for name, value in EXAMPLES.items():
            with self.subTest(name=name):
                check(name, value)
        cap = EXAMPLES['Capability']
        Draft202012Validator(cap['input_schema']).validate(EXAMPLES['ExecutionRequest']['input'])
        Draft202012Validator(cap['output_schema']).validate({'artifact': EXAMPLES['Receipt']['artifacts'][0]})

    def test_openapi_internal_references(self):
        api = json.loads((ROOT / 'openapi.json').read_text())
        names = set(api['components']['schemas'])
        def walk(x):
            if isinstance(x, dict):
                if '$ref' in x:
                    r = x['$ref']
                    if r.startswith('#/components/schemas/'):
                        self.assertIn(r.rsplit('/',1)[-1], names)
                    elif r.startswith('./schemas/wis.schema.json#/$defs/'):
                        self.assertIn(r.rsplit('/',1)[-1], SCHEMA['$defs'])
                    else:
                        self.fail(f'Unexpected ref {r}')
                for v in x.values(): walk(v)
            elif isinstance(x, list):
                for v in x: walk(v)
        walk(api)
        ids = [op['operationId'] for path in api['paths'].values() for op in path.values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_resource_arithmetic(self):
        resource_invariants(EXAMPLES['UserResources'])

    def test_bad_resource_arithmetic(self):
        value = deepcopy(EXAMPLES['UserResources'])
        value['pocket_money']['available_minor'] += 1
        with self.assertRaises(ValueError): resource_invariants(value)

    def test_implicit_conversion_forbidden(self):
        value = deepcopy(EXAMPLES['UserResources'])
        value['implicit_conversion'] = True
        with self.assertRaises(ValidationError): check('UserResources', value)

    def test_energy_has_no_currency(self):
        value = deepcopy(EXAMPLES['UserResources'])
        value['energy_pools'][0]['currency'] = 'AUD'
        with self.assertRaises(ValidationError): check('UserResources', value)

    def test_negative_money_forbidden(self):
        money = {'currency':'AUD','minor_units':-1,'exponent':2}
        with self.assertRaises(ValidationError): check('Money', money)

    def test_manifest_cannot_publish_private_balance(self):
        value = deepcopy(EXAMPLES['Manifest'])
        value['pocket_money'] = EXAMPLES['UserResources']['pocket_money']
        with self.assertRaises(ValidationError): check('Manifest', value)

    def test_quote_accepts_authorized_purchase(self):
        quote_gate(self.quote, **self.gate_args)

    def test_expired_quote_rejected_for_new_execution(self):
        self.quote['expires_at'] = '2026-09-08T14:59:59Z'
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)

    def test_estimated_price_rejected(self):
        self.quote['binding'] = 'estimate'
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)

    def test_price_over_authority_rejected(self):
        self.quote['all_in_max']['minor_units'] += 1
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)

    def test_unapproved_effect_rejected(self):
        self.quote['effects'].append('publish')
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)

    def test_currency_mismatch_rejected(self):
        self.quote['all_in_max']['currency'] = 'USD'
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)

    def test_parallel_reservations_do_not_overspend(self):
        wallet = AllowanceModel(100)
        with ThreadPoolExecutor(max_workers=16) as pool:
            accepted = list(pool.map(lambda i: wallet.reserve(f'hold-{i}',7), range(100)))
        self.assertEqual(sum(accepted),14)
        self.assertEqual(wallet.available,2)

    def test_duplicate_hold_does_not_reserve_twice(self):
        wallet=AllowanceModel(100)
        self.assertTrue(wallet.reserve('hold',70))
        self.assertTrue(wallet.reserve('hold',70))
        self.assertEqual(wallet.available,30)

    def test_hold_reuse_with_new_amount_rejected(self):
        wallet=AllowanceModel(100)
        wallet.reserve('hold',70)
        with self.assertRaises(ValueError): wallet.reserve('hold',80)

    def test_settlement_releases_unused_reservation(self):
        wallet=AllowanceModel(100)
        wallet.reserve('hold',70)
        wallet.settle('hold',60)
        wallet.settle('hold',60)
        self.assertEqual(wallet.available,40)
        self.assertEqual(wallet.spent,60)

    def test_capture_above_reservation_is_rejected(self):
        wallet=AllowanceModel(100)
        wallet.reserve('hold',70)
        with self.assertRaises(ValueError): wallet.settle('hold',71)
        self.assertEqual(wallet.available,30)

    def test_duplicate_execution_has_same_identity(self):
        model=ExecutionModel()
        request=EXAMPLES['ExecutionRequest']
        gate=lambda: quote_gate(self.quote, **self.gate_args)
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids=list(pool.map(lambda _: model.accept(request,gate),range(50)))
        self.assertEqual(set(ids),{'execution-1'})
        self.assertEqual(len(model.records),1)

    def test_idempotency_conflict(self):
        model=ExecutionModel()
        request=deepcopy(EXAMPLES['ExecutionRequest'])
        model.accept(request,lambda:None)
        request['input']['visibility']='public'
        with self.assertRaises(ValueError): model.accept(request,lambda:None)

    def test_accepted_operation_survives_quote_expiry(self):
        model=ExecutionModel()
        request=EXAMPLES['ExecutionRequest']
        gate=lambda: quote_gate(self.quote, **self.gate_args)
        original=model.accept(request,gate)
        self.gate_args['now']=datetime(2026,9,9,tzinfo=timezone.utc)
        self.assertEqual(model.accept(request,gate),original)
        with self.assertRaises(ValueError): quote_gate(self.quote, **self.gate_args)


if __name__ == '__main__':
    unittest.main(verbosity=2)
