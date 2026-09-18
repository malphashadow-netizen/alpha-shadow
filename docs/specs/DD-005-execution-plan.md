# DD-005 — خطة تنفيذ تكلفة المخزون (FIFO)

**آخر تحديث مقابل:** `main` عند `50be2d6e33a71b815881e86e796834f328d1431a`
**وسوم التحقق:** `[مؤكد]` مقروء من الكود · `[أعد التحقق]` من قراءة أقدم، اعمل grep قبل البناء عليه · `[غير متحقق]` مفيش دليل، ممنوع الاعتماد عليه.

---

## 0. قواعد الشغل (تُقرأ قبل أي سطر كود)

**الكود هو الحقيقة الوحيدة. صفر اعتماد على أي `.md` — بما فيها هذا الملف.** التوثيق متأخر عن الكود في مواضع مؤكدة. أي بند هنا يخالف الكود: الكود يكسب، والملف يتصحح في نفس الكوميت اللي لمس الموضوع.

**الصدق قبل راحة أي طرف.** الخبر الوحش يُقال كما هو. الغلط يُعترف به مرة ويُصلَّح جوهره. وممنوع ادّعاء "تحققت" من غير قراءة فعلية — الوسم `[غير متحقق]` أشرف من تخمين واثق.

**السيستم ديناميكي زي الشركات.** مفيش قوائم مغلقة لبيانات التاجر: الوحدات `text` حرة، الأسماء JSONB بلا allow-list للغات، أسباب التعديل صفوف يكتبها التاجر فوق مفردات منصة ثابتة. أي تصميم يجبر التاجر يعدّل كود عشان يضيف صنف أو سبب أو عملة = مرفوض.

**الذاكرة بتموت بين الجلسات، والكونتينر كمان.** الشغل ضاع أربع مرات لأن الكوميت المحلي بيتبخر. القاعدة: **مفيش "اعمل واستنى المراجعة" قبل الـpush.** التسليم في نفس الجلسة، والمراجعة على GitHub.

**ممنوع الرجوع لمرحلة خلصت.** أي بند تحته "تم" لا يُعاد تنفيذه؛ لو Codex لمسه يبقى البرومبت غلط.

---

## 1. الحالة المؤكدة من الكود

**المخزون مفرّع.** `inventory_items` صف لكل (فرع، مكوّن)، `branch_id NOT NULL`، و`current_quantity NUMERIC(18,4)` **مشتقة** من `stock_movements` ومحمية بـ`guard_inventory_item_writes` تحت GUC. مفيش CHECK غير سالب **بالتصميم** — البيع في نقص مسموح بـmanager override وclaim مستخدم لمرة واحدة، والرفض في `validate_stock_movement` بـ`23514` وبادئة `stock: insufficient quantity`. `[مؤكد — 0037، 0040]`

**`stock_movements` append-only** بستة أنواع مؤكدة حرفياً من `stock_movements_type_valid`: `sale_deduction`, `void_restoration`, `waste_void`, `waste_refund`, `manual_receiving`, `manual_adjustment`. و`stock_override_claims` مفتاحه الأساسي يمنع الـdouble-claim بنيوياً (`23505`). `[مؤكد — 0040]`

**الوصفات بالوحدة الأساسية.** `menu_item_recipes`، العمود `quantity_required NUMERIC(18,4) CHECK > 0`، والقاعدة LOCKED في الهيدر: لا تحويل وقت الخصم، و`unit_conversions` شأن استلام فقط. **الملف اسمه `0039a_phase9_menu_item_recipes.sql` — مفيش ملف اسمه `0039`؛ فيه `0039b` للـmodifiers غير مقروء.** `[مؤكد]` · **مفيش أي دليل على view اسمه `recipe_ingredients`.** `[غير متحقق]`

**العملات.** `currencies (code text PRIMARY KEY, minor_unit_digits smallint NOT NULL)` مع `CHECK (minor_unit_digits BETWEEN 0 AND 4)` و`CHECK (code ~ '^[A-Z]{3}$')`. `[مؤكد — 0006]`

**الحارس append-only المرجعي:** `prevent_exchange_rate_mutation()` في `migrations/0006_phase4_multi_currency_audit.sql:51-65` — دالة plpgsql ترمي `RAISE EXCEPTION … USING ERRCODE = '55006'`، وتريجر `BEFORE UPDATE OR DELETE … FOR EACH ROW`. هذا هو النمط الذي تُنسخ منه كل حواجز append-only الجديدة. `[مؤكد]`

**`GENERATED ALWAYS AS IDENTITY` له سابقة في المستودع:** `journal_entries.entry_number bigint GENERATED ALWAYS AS IDENTITY`. `[مؤكد — 0060:40]`

**طبقة المال.** `Money` بـ`bigint` minor units، `allocate()` توزيع Fowler دقيق، و`assertMinorUnitDigits` يرفض أي scale فوق 4 برمي استثناء. `convertMoneyAtRate()` موجودة وهيدر الملف يقول إنها التنفيذ الوحيد للتحويل. `[مؤكد — src/shared/money.ts]`

**أسباب التعديل اليدوي.** `0049_backlog_i1_adjustment_reasons.sql`: `adjustment_reason_kinds` مفردات منصة ثابتة (guard trigger + REVOKE + SELECT فقط) بالقيم `count_correction`, `damage`, `expiry`, `shrinkage`, `other`؛ `tenant_adjustment_reasons` صفوف التاجر بـFK إجباري للـkind؛ `tenant_adjustment_reason_kind_settings` للتعطيل بدل الحذف. CHECKان متقابلان: `manual_adjustment` يلزمه سبب وغيره ممنوع منه. الـbackfill ممنوع صراحة. `[مؤكد]`

**الترحيل المحاسبي قائم:** `postPaymentJournalEntry` و`postPaymentJournalReversalEntry`، و`prevent_journal_mutation`، و`require_balanced_journal_entry`، و`journal_entry_lines_side_check` (سطر بصفر مرفوض بنيوياً)، وحارس `cardinality(debit_ids) = 1 AND cardinality(credit_ids) = 1` برسالة `accounts are missing or ambiguous`. `[أعد التحقق]`

**الأقفال:** منع `pg_advisory_*` في `src/` مثبّت بتيست لا بوثيقة، و`lock-order-audit.test.ts` حارس وجود فقط. `[أعد التحقق]`

---

## 2. المرحلة صفر — **تمت** (`0067` + `roles/018`)

ممنوع إعادة تنفيذ أي بند هنا. المنفَّذ في `migrations/0067_dd005_accounting_foundation.sql`: `[مؤكد]`

فهرس فريد جزئي `idx_accounts_tenant_system_purpose_unique ON accounts (tenant_id, system_purpose) WHERE system_purpose IS NOT NULL` — على مستوى الـtenant بلا فرع لأن `accounts` مفيهوش `branch_id`. ومفتاح خارجي idempotent `branches_base_currency_fkey → currencies(code)`. وعمود `exchange_rates.rate_source` **nullable بلا DEFAULT** مع CHECK على `('market','till_manual')`، وتعليق صريح إن NULL = غير مصنّف وإن التقارير تفلتر `= 'market'` fail-closed، وفهرس على `(tenant_id, from_currency, to_currency, rate_source, effective_at DESC)`. والتريجر `log_payment_method_rate_change` يبصم `till_manual`. ودالتا الزرع `seed_tenant_dd005_accounts(uuid)` و`seed_tenant_dd005_system_user(uuid)` بـ`SECURITY DEFINER`، تستعيدان `app.current_tenant_id` قبل كل مخرج بما فيها الـ`RAISE`، وتُناديان من `seed_new_tenant_payment_accounts`. وأربع `REVOKE ALL ON FUNCTION … FROM PUBLIC` في آخر الملف.

**الأكواد المثبّتة نهائياً:** `1200` inventory_asset · `1300` cost_of_goods_in_process · `5000` cost_of_goods_sold · `5100` waste_expense · `5200` purchase_price_variance · `5300` inventory_variance. (لاحظ `1300` لا `1210`.) `[مؤكد]`

### تصحيح خطأ سابق: `is_active`

**نسخة سابقة من هذا الملف كتبت `is_active = true` بحجة أن `validate_stock_movement` يفحص ذلك. السطر غلط، والمنفَّذ `false`، والمنفَّذ هو الصح.** الفحص `u.is_active` واقع على `stock_movements.actor_user_id` وحده، ومستخدم النظام لن يكتب حركة مخزون أبداً — هو `posted_by` للقيود والـsweep فقط، والتعطيل يمنع الـlogin. `[مؤكد — 0040]`

**البند مقفول:** `grep -n 'is_active' migrations/0060_payment_journal_entries.sql` أرجع نتيجة واحدة فقط (السطر 19، تعريف عمود) ولا يوجد أي فحص على `posted_by`. قرار `is_active = false` آمن للمرحلة الرابعة. `[مؤكد]`

كذلك `test/integration/dd005-phase0.test.ts` مثبّت `{ is_active: false, is_system_accounting_user: true }`، فأي تغيير للقرار = ميجريشن جديدة + تعديل تيست، لا تعديل سطر.

### ملاحظات مسجّلة في `docs/backlog.md` تحت "DD-005 phase 0" `[مؤكد]`

استعادة السياق بـ`coalesce(v_prev, '')` تجعل الفشل المقفول يظهر `22P02` بدل `42704` — ممنوع أي كود يفرّق بين "بلا سياق" و"سياق غلط" بكود الخطأ. وكل tenant عنده صف `users` معطّل بـ`is_system_accounting_user = true` — قوائم الموظفين وعدّادات المستخدمين تستثني الفلاج صراحةً، **لا بالإيميل**. و`REVOKE ALL ON FUNCTION` على دالة تريجر **لا** يمنع التريجر من الاشتعال (بوستجرس يفحص EXECUTE وقت `CREATE TRIGGER`).

### المتبقي من المرحلة صفر (توثيقي بحت)

حالة DD-005 في `docs/accounting-design-decisions.md` والجملة داخل DD-003 عن تأجيل DD-004/DD-005، وبند FX في `backlog.md` الذي يقول إن التحويل غير منفَّذ بينما `convertMoneyAtRate` موجودة. `[أعد التحقق عند التعديل]`

### استعلام الـpreflight (قراءة فقط — يُشغَّل قبل أول `npm run migrate` على أي قاعدة فيها tenants)

```sql
WITH expected(code, purpose) AS (
  VALUES
    ('1200', 'inventory_asset'),
    ('1300', 'cost_of_goods_in_process'),
    ('5000', 'cost_of_goods_sold'),
    ('5100', 'waste_expense'),
    ('5200', 'purchase_price_variance'),
    ('5300', 'inventory_variance')
)
SELECT 'code_purpose_conflict' AS issue, a.tenant_id, a.code, a.system_purpose
FROM accounts a
JOIN expected e ON e.code = a.code
WHERE a.system_purpose IS DISTINCT FROM e.purpose
UNION ALL
SELECT 'purpose_on_unexpected_code', a.tenant_id, a.code, a.system_purpose
FROM accounts a
JOIN expected e ON e.purpose = a.system_purpose
WHERE a.code IS DISTINCT FROM e.code
UNION ALL
SELECT 'unknown_branch_currency', b.tenant_id, b.base_currency, NULL
FROM branches b
LEFT JOIN currencies c ON c.code = b.base_currency
WHERE c.code IS NULL
UNION ALL
SELECT 'duplicate_system_purpose', a.tenant_id, a.system_purpose, count(*)::text
FROM accounts a
WHERE a.system_purpose IS NOT NULL
GROUP BY a.tenant_id, a.system_purpose
HAVING count(*) > 1;
```

---

## 3. المرحلة الأولى — الليدجر والطبقات عند الاستلام

**هذه هي المرحلة 1. طبقات التكلفة تُنشأ هنا مع الاستلام، لا في مرحلة لاحقة.** أي نسخة سابقة من هذا الملف تضعها في المرحلة 3 ملغاة.

تنقسم لجزأين لأن كتابة الليدجر من طبقة التطبيق لا من تريجر (انظر شرط التوقيت أدناه): **1a = البنية وقوانينها** (ميجريشن + `roles/019` + تيستات تثبت القوانين بالـSQL مباشرة). **1b = توصيل مسار الاستلام في TypeScript.**

جدولان فقط: `inventory_cost_ledger` و`inventory_cost_layers`. **ولا جدول ملخص للكمية** — الكمية عندها مصدر حقيقة واحد محمي، وأي جدول بكمية ثانية يخلق تعارضاً مستحيل التشخيص. الإسقاط الجديد يحمل **القيمة** فقط.

المفتاح `(tenant_id, inventory_item_id)` بلا عمود فرع لأن `inventory_items` مفرّع فالفرع مُضمَّن — قرار **يُوثَّق**: المرحلة السادسة ستحتاج JOIN على `inventory_items` لاستخراج الفرع، وتكلفة الاستعلام معلنة مقبولة.

الترتيب بـ`bigint GENERATED ALWAYS AS IDENTITY`، وترتيب FIFO = ترتيب الـidentity. monotonic بلا قفل، ويتجنّب نمط `order_event_sequence` المولّد لـF-1. **ممنوع عمود `sequence_no` يدوي.**

التكلفة **إجمالي بالوحدات الصغرى** لا سعر وحدة: `assertMinorUnitDigits` يرفض أي scale فوق 4، وسعر وحدة لصنف بالجرام يقع تحت الحد فيولّد drift تراكمي. الأعمدة: `total_cost_minor bigint` · `original_qty NUMERIC(18,4)` · `currency_code` (snapshot من `branches.base_currency`) · `minor_unit_digits smallint CHECK BETWEEN 0 AND 4` (snapshot، مطابق لقيد `currencies`) · `is_provisional boolean`. والاستهلاك يوزّع وحدات صحيحة بمنطق `allocate()` فالتصالح **exact** لا تقريبي. الإدخال `unitCostText` بعملة الفرع وبوحدة الشراء، والإجمالي يُقرّب **مرة واحدة** half-even.

**صفر قفل جديد، بشرط توقيت صريح.** الحماية من `apply_stock_movement()` وهو `AFTER INSERT` ويعمل `UPDATE inventory_items` **بلا شرط نوع حركة** فيأخذ row lock محتفظاً به للـcommit — **لا** من `FOR UPDATE` في `validate_stock_movement` المشروط بـ`sale_deduction` وحده. أي على مسار `manual_receiving` القفل غير مأخوذ قبل الـAFTER INSERT. `[مؤكد — 0040]`

**نتيجة مباشرة:** كتابة الليدجر تحصل **بعد** اكتمال إدراج صف `stock_movements` داخل نفس الترانزاكشن من طبقة التطبيق — **ليست تريجراً**. ولو استُخدم تريجر لاحقاً لأي سبب، اسمه يجب أن يترتّب أبجدياً بعد `trg_apply_stock_movement` (بوستجرس ينفّذ تريجرات نفس الحدث بترتيب الاسم)؛ `trg_cost_ledger_…` مقبول و`trg_a…` كارثة صامتة.

الليدجر append-only بحارس على نمط `prevent_exchange_rate_mutation` (`0006:51-65`) مع `REVOKE UPDATE, DELETE`، وقالب RLS كامل (`ENABLE` + `FORCE` + `tenant_isolation`) في نفس الميجريشن لأن `rls-coverage.test.ts` يكسر الـCI على أي جدول بعمود `tenant_id` بلا policy.

**ملف أدوار `migrations/roles/019_dd005_phase1.sql`** — 018 مأخوذ. وملفات `roles/` **لا تُطبَّق** لا بـ`tools/migrate.ts` ولا بالـharness، فالـCI يبقى أخضر والتشغيل يرمي `permission denied`. المنح على مستوى العمود لا الجدول: `SELECT, INSERT` على الجدولين، و`UPDATE (remaining_qty, remaining_cost_minor)` على الطبقات فقط. `[مؤكد]`

**ممنوع دالة زرع حسابات جديدة.** الستة مزروعة في `0067` بالأكواد أعلاه؛ أي دالة ثانية ستصطدم بـ`23505` على الفهرس الفريد.

---

## 4. المرحلة الثانية — الاستهلاك والقيد الوسيط (كوميت واحد)

`consumption_allocations` بـ`layer_id` و`order_item_id` و`qty` و`allocated_cost_minor`، السحب بترتيب identity تصاعدياً، داخل نفس ترانزاكشن إنشاء الأوردر.

**القيد يُكتب هنا ولا يُؤجَّل، والسبب ثقب مؤكد:** `writeVoidStockMovements` يكتب `waste_void` حين يكون العنصر `fires_kitchen_ticket`، والـCHECK يفرض `quantity_delta = 0` فالكمية استُهلكت للأبد. ولأن `assertVoidAllowedUnderPaymentStatus` يرفض الـvoid على أي أوردر غير `open` بـ`PaymentReversalRequiredError`، فهذا الأوردر لن يُدفع أبداً وDD-003 لن ترحّل له شيئاً. **قيمة تخرج من الأصول بلا سطر في الـGL، بشكل دائم.** `[أعد التحقق]`

الحل: عند `sale_deduction` مدين Cost of Goods in Process ودائن Inventory Asset، بـ`source_type = 'inventory_consumption'` و`source_id = order_id`. والـUNIQUE على `(tenant_id, source_type, source_id)` يمنع الازدواج بنيوياً، والمرحلة الرابعة تستخدم `source_type` مختلفاً فلا تعارض — نفس مبدأ `payment` مقابل `payment_reversal`.

الكمية السالبة: طبقة `is_provisional` بآخر تكلفة معروفة، ثم true-up لفرق Purchase Price Variance عند الاستلام الحقيقي. رفض البيع كان سيكسر سلوكاً قائماً ومقصوداً في قاعدة البيانات.

التكلفة الصفرية مستحيلة الترحيل (`side_check` يرفض سطر الصفر، و`postPaymentJournalEntry` يرفض `amountMinor <= 0n`). القرار المعلن: تخطّي الترحيل **مع** صف في `audit_log`، ولا صمت.

كل كود ترحيل جديد يستخدم نفس نمط الـcardinality guard، ولا يفترض أن الـUNIQUE وحده ضمان كافٍ.

---

## 5. المرحلة الثالثة — الـVoid والـRefund

حالتان محاسبيتان مختلفتان: الـvoid حصراً قبل الدفع فلا قيد مُرحّل يُعكس، والـrefund بعد الدفع فالعكس مطلوب. `writeRefundStockMovements` مُنفَّذ في `payments-engine.ts` ويُنادى عند `to === 'refunded'`، وهيدر `void-modification-engine.ts` الذي يقول "payments engine is a future phase" **نص بائت يُصحَّح في نفس الكوميت**. `[أعد التحقق]`

`void_restoration` يكتب تخصيصات **سالبة جديدة** تشير إلى نفس الطبقات الأصلية — append-only محفوظ والإسقاط قابل لإعادة البناء.

**تحذير جوهري:** `loadWasteRefundKeys` يفلتر `movement_type IN ('waste_refund','void_restoration')` — أي أن `void_restoration` يُكتب من مسارين مختلفين محاسبياً. **عكس التكلفة يجب أن يفرّق بحالة الخط (`is_voided`) لا بنوع الحركة وحده**، وإلا ستعكس مرتين أو تتخطّاها. `[أعد التحقق]`

`waste_void` مدين Waste Expense ودائن Cost of Goods in Process — حساب منفصل لا COGS، لسبب تجاري: أهم رقمين لصاحب مطعم هما نسبة تكلفة الطعام ونسبة الهالك، ودمجهما يحرمك أقوى ميزة تحليلية، وإعادة تصنيف قيود مُرحّلة لاحقاً مشروع مؤلم.

أي عكس يمشي بعد `postPaymentJournalReversalEntry` وفي نفس الترانزاكشن، بحراسة `NOT EXISTS` مزدوجة.

---

## 6. المرحلة الرابعة — الترحيل عند اكتمال الدفع

على الدفعة التي تصفّر الرصيد لا كل دفعة جزئية: مدين COGS ودائن Cost of Goods in Process، بـ`source_type = 'order_cogs'` و`source_id = order_id`. النتيجة: الـGL متوازن في كل لحظة، ورصيد الحساب الوسيط = قيمة الأوردرات المفتوحة المخصومة، رقم قابل للتحقق لحظياً. والأوردرات المتروكة تحتاج sweep يعمل بمستخدم النظام.

---

## 7. المرحلة الخامسة — التعديل اليدوي

الربط على `adjustment_reason_kind_code` **لا** على `adjustmentReasonId`: أول سبب جديد يكتبه التاجر من الواجهة سيكون بلا حساب والترحيل سيفشل في وجه الكاشير. الصفوف القديمة `adjustment_reason_id = NULL` (الـbackfill محرّم)، ومنطق الترحيل يتعامل مع الـNULL بصراحة.

بوابة النقص مشروطة بـ`sale_deduction` — مؤكد من `0040` `[مؤكد]` ومن تعليق `insertStockMovement` في `postgres-payments-store.ts` `[أعد التحقق]`. أي أن الخصم اليدوي يمر بلا فحص ويقدر يودّي الرصيد تحت الصفر، ومنطق نقص الطبقات مطلوب هنا كذلك.

الزيادة تحت `count_correction` تُسعّر بتكلفة أقدم طبقة نشطة مع استثناء `is_provisional`، والرجوع لآخر استلام حقيقي، ولو لا يوجد نهائياً **يُرفض التعديل ويُطلب سعر صريح**. لا تسعير جرد من تخمين. المقابل: Inventory Variance.

---

## 8. المرحلة السادسة — التقارير عبر الفروع

قيمة المخزون **رصيد لا معاملة**: تجميع داخل كل فرع بعملته وبتكلفة الطبقات الأصلية، ثم ترجمة الإجمالي **مرة واحدة** بسعر إغلاق معلن من `rate_source = 'market'` فقط، مع إظهار السعر وتاريخه. لا ترجمة كل طبقة بسعر اليوم، ولا خلط أسعار تاريخية بسعر إغلاق في نفس المجموع. عملة الهدف من `tenants.reporting_currency`.

`CurrencyConversionEngine` fail-closed بالتصميم: `findAtOrBefore` بلا inverse-rate fallback وبلا current-rate lookup، ويرمي `MissingExchangeRateError`. فمسار إدخال أسعار market يكون بالزوج الصريح في اتجاه التقرير (عملة الفرع ← عملة التقرير) بلا أي عكس حسابي، لأن العكس يخلق دقة وهمية. **المسار يُبنى في نفس المرحلة، لا يُكتشف وقت أول تقرير.** `[أعد التحقق]`

---

## 9. المرحلة السابعة — التصالح

إعادة بناء الطبقات والقيمة من `inventory_cost_ledger` + `consumption_allocations` ومقارنتها بالإسقاط. **يبلّغ ولا يصلّح أبداً** — الـauto-heal يخفي البج بدل أن يكشفه. وsnapshots مجمّدة شهرية لأن إعادة البناء من الصفر تصبح غير قابلة للتشغيل بعد سنتين.

عقبة حقيقية: دور `app_batch` غير موجود، وأي job عبر الـtenants لن يقدر يتخطى RLS من مسار `withTenantContext`. المرحلة تحتاج تصميم الدور وقائمة استعلاماته المعتمدة **أولاً**. `[أعد التحقق]`

---

## 10. بنود backlog تُعلن الآن ولا تُنفَّذ

التحويل بين الفروع غير قابل للتمثيل: الأنواع ستة ولا يوجد `transfer`، فالتحويل اليوم = `manual_adjustment` سالب هنا وموجب هناك بلا رابط، فالتكلفة تنقطع والـFIFO يختل. ومرتجع المشتريات للمورد **ليس FIFO** — يسحب من طبقة المورد المحددة وإلا يرجّع بسعر ليس سعره. وإغلاق الفترات: استلام بتاريخ رجعي بعد ترحيل الشهر يجعل COGS المُرحّل خطأ رياضياً، والأنظف منع الـbackdating بعد الإغلاق.

---

## 11. كيف يُنفَّذ هذا مع Codex

**اكتب الـspec قبل البرومبت، والبرومبت يشير إلى الـspec لا يعيد شرحه.** وقل صراحةً في كل مرة: لا تنشئ أي جدول أو قفل أو ملف غير المذكور، ولو وجدت تعارضاً **توقّف واسأل ولا تجتهد**. وحين يتوقف فعلاً: **صحّح المصدر، لا تأمره بتجاوزه.**

**أمر الـsnapshot قبل التيستات لا بعدها.** بمجرد توليد الملفات: `git add -A && git commit && git push origin HEAD:refs/heads/dd005-wip-snapshot`. الكونتينر يموت والكوميت المحلي يموت معه.

**ممنوع "اعمل التغيير واستنى المراجعة".** المراجعة على GitHub بعد الـpush. ولو الفرع ليس `main`: **انقل إلى `main`**، لا تقل "قف".

**مرحلة واحدة = PR واحد = ميجريشن واحدة.** الـdiff يتجاوز ~600 سطر يُقسَّم.

**أول PR في كل مرحلة تيستات فاشلة تثبّت القوانين:** `SUM(allocations) = layer total` كمساواة أعداد صحيحة تامة، و`net(ledger) - net(allocations) = current_quantity`. ثم الكود حتى تخضرّ. **ولا تعديل تيست قائم ليعدّي** — الاستثناء الوحيد الذي حصل كان عدّادات `journal-entries.test.ts` بعد زرع الستة حسابات، وبتعليق يشرح الرقم.

**تحقق قبل الافتراض:** ممنوع افتراض وجود دور أو جدول أو عمود بلا grep. الـharness يشغّل `migrations/*.sql` و`seed.test.sql` فقط، فـ`app_login` **غير موجود** في الكلاستر المؤقت — أي تيست يحتاج دوراً ينشئ دوراً مؤقتاً باسم عشوائي ويمنحه سطور ملف الأدوار حرفياً، وينظّف بـ`DROP OWNED BY` + `DROP ROLE IF EXISTS` في `afterAll` (نمط `auth-audit-role.test.ts`).

**الأنواع:** `eslint.config.js` يعطّل `no-unsafe-call` و`no-unsafe-member-access` **فقط** — `no-unsafe-assignment` شغّال، و`pg` يرجّع `QueryResult<any>`. الحل: `interface` صريح لكل صف + `client.query<Row>()`، وtype guard لقراءة `error.code`. ممنوع `any`، `as any`، `@ts-ignore`، `eslint-disable`، أو تعديل `eslint.config.js` / `tsconfig.json`.

**المحرّمات الدائمة:** لا `UPDATE`/`DELETE`/`TRUNCATE` على `exchange_rates` في أي ميجريشن أو كود (تيست إثبات الرفض مستثنى)، لا `reset --hard` ولا `checkout -f` ولا `push --force` ولا حذف فروع، لا تعديل ميجريشن مدموجة (الجديد ميجريشن جديدة)، ولا `EXCEPTION WHEN OTHERS` ولا تعطيل RLS ولا `BYPASSRLS` ولا `session_replication_role`.

**سيناريو ذهبي مقروء بالعين في كل مرحلة:** استلم 10 بـ5، استلم 10 بـ7، بِع 15 ← COGS = 85 بالضبط والمتبقي 5 بـ7. ثم void لخمسة ← ترجع لطبقة الـ7 بالتحديد.

**المراجعة اليدوية على أربعة أشياء فقط:** أي `FOR UPDATE` جديد، أي `await` داخل loop داخل ترانزاكشن، أي استخدام `number` مع مبلغ، وأي `catch` يبلع خطأ.

---

## 12. بنود غير متحققة — ممنوع البناء عليها قبل grep

محتوى `0039b_phase9_modifier_recipes.sql` · النص الحرفي لحالة DD-005 وجملة DD-003 في `accounting-design-decisions.md` · بند FX في `backlog.md` · وجود ونص هيدر `void-modification-engine.ts` و`loadWasteRefundKeys` و`CurrencyConversionEngine` و`postgres-payments-store.ts` — كلها من قراءات أقدم.
