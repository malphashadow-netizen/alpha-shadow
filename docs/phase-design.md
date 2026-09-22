## Compliance Documents Framework — Migration 0080 (Phase: Tax Core / Compliance Layer)

### الحالة الحالية (Status)
- تم الدفع (push) بنجاح إلى origin/main بتاريخ 2026-09-22.
- Commit hash: 1bd7106830762fa2e789dff7e97f5613b339860e
- Parent commit: 5954f1112422a7d4637e2776564f2c001b837e1d
- الملف: migrations/0080_compliance_documents_framework.sql (176 سطر إضافة، بدون حذف)
- جميع الفحوصات نجحت: check:migrations (exit 0)، lint:eslint (exit 0)، اختبارات كاملة 1007/1007 ناجحة (exit 0).

### الجداول المُنشأة
- compliance_document_status_transitions: جدول بيانات (policy-as-data) لقواعد الانتقال المسموحة.
- compliance_documents: الجدول الرئيسي، الحالة (document_status) مشتقة (derived) لا تُكتب مباشرة.
- compliance_document_transitions: سجل append-only، مصدر الحقيقة (source of truth) للحالة.

### قرارات التصميم الموثّقة (Design Decisions)
- **D-1 (قرار جديد، غير مستخرج من كود سابق):** مسار الانتقال FAILED → RETRY → GENERATED معتمد رسميًا، إلى جانب باقي المسارات الـ11 في compliance_document_status_transitions.
- استخدام IS DISTINCT FROM بدل <> في جميع فحوصات NULL-safety داخل الدوال (validate_compliance_document_transition، guard_compliance_document_derived_status).
- عمود submission_attempt_no منفصل تمامًا عن عدد صفوف compliance_document_transitions؛ يُزاد فقط عند to_status = 'SUBMITTED'.
- artifact_reference / artifact_hash بدل signed_payload_reference (تجريد التخزين، لا ربط مباشر بمزوّد تخزين معيّن).
- لا يوجد ربط مباشر بين إنشاء compliance_document ونجاح الدفع (payment)؛ الأهلية تُبنى على اكتمال tax evidence وليس على جدول payments.
- الانتقال الأول (from_status IS NULL → DRAFT) مضمون الحدوث مرة واحدة فقط لكل document عبر unique partial index (idx_compliance_document_transitions_single_initial)، وأيضًا مفروض عبر constraint trigger مؤجّل (trg_require_initial_compliance_transition) يضمن عدم وجود compliance_document بلا حدث ابتدائي.
- الـ composite FK يتبع نفس نمط المشروع: (order_id, tenant_id) → orders(id, tenant_id)، وكذلك (branch_id, tenant_id) → branches(id, tenant_id) و(compliance_document_id, tenant_id) → compliance_documents(id, tenant_id).

### ⚠️ دين تقني موثّق (Technical Debt — مقصود ومؤجّل بوعي)
- **العمود authority_id (uuid NOT NULL) في جدول compliance_documents لا يحمل قيد FOREIGN KEY.**
- السبب: لا يوجد حاليًا في المشروع أي جدول tax_authorities أو ما يعادله (تم التأكد بـ grep على جميع ملفات migrations/*.sql بتاريخ 2026-09-22، النتيجة: لا يوجد تطابق).
- القرار: تفضيل ترك العمود بلا FK بدل تكرار خطأ سابق (ربط جدول بعمود/جدول غير موجود، كما حدث مع jurisdiction_id → tax_jurisdictions(id) قبل التصحيح).
- الأثر الحالي: لا يوجد فحص تكامل مرجعي (referential integrity) على authority_id؛ يمكن إدخال أي UUID عشوائي دون رفض من قاعدة البيانات.
- **إجراء مطلوب مستقبلًا:** عند إنشاء جدول tax_authorities (أو ما يعادله ضمن Layer 1 — Tax Core)، يجب فتح migration جديدة (ALTER TABLE compliance_documents ADD CONSTRAINT ... FOREIGN KEY (authority_id) REFERENCES tax_authorities (id)) ولا يجوز اعتبار الدين هذا مغلقًا قبل ذلك.
- حالة الدين: 🔴 مفتوح.

### الخطوات القادمة المخطط لها (Not started yet)
- Layer 4 — Adapter contract: واجهة TypeScript (buildDocument / sign / submit / getStatus) مع اختبارات contract test بواجهات mock.
- إغلاق الدين التقني الخاص بـ authority_id بعد إنشاء tax_authorities.

## تصحيح معماري — Layer 4 (Adapter Contract) — بتاريخ 2026-09-22

### الفرضية الأصلية المرفوضة
كان القرار السابق في قسم "الخطوات القادمة" يقول: "Layer 4 — Adapter contract: واجهة TypeScript (buildDocument / sign / submit / getStatus) مع اختبارات contract test بواجهات mock." هذه الفرضية **مرفوضة** بعد فحص عميق للمشروع، للأسباب التالية:

1. **تعارض مباشر مع قاعدة معمارية موجودة صريحة في vitest.config.ts:** مشروع `contract` في هذا المستودع معرّف حرفيًا بأنه "architectural invariants checked against a REAL PostgreSQL catalog (pg_tables / pg_policies) + runtime guards (no InMemory repository in production)"، وينص صراحة: "There is deliberately NO mock database option: the spec forbids validating RLS against anything but a real server." إذن "contract test بواجهة mock" يخالف هذا القيد المعماري المُلزم.
2. **الأمثلة الفعلية للـ contract tests (test/contract/auth-schema.test.ts وغيرها) كلها تفحص كاتالوج PostgreSQL حقيقي** (pg_class, pg_policies, pg_proc, information_schema.columns)، وليست اختبارات لواجهات TypeScript بمزودين وهميين.
3. **افتراض تجزيء الواجهة لأربع دوال مستقلة (buildDocument/sign/submit/getStatus) غير مثبت** أنه الشكل الصحيح لكل الجهات التنظيمية؛ بعض الجهات تنفّذ build+sign+submit كنداء واحد. النمط الفعلي في المشروع (PaymentsTxScope, OrderTaxScope) لا يجزّئ العمليات الداخلية للـ port العام؛ كل ما هو "تفصيل تنفيذ داخلي" يبقى خلف الـ port، لا يُعرَّض كدوال مستقلة.
4. **لا يوجد أي نمط "Adapter" لخدمة SaaS/جهة تنظيمية خارجية في المشروع حاليًا.** كل استخدام لكلمة Adapter في الكود الحالي (مثل postgres-tax-resolution-transaction.ts) يعني "تنفيذ PostgreSQL لِـ port داخلي"، ليس بوابة لخدمة خارجية. هذا القرار سيكون أول سابقة من نوعه.
5. **مجلد src/application/engines/integrations/index.ts موجود بالفعل كـ placeholder فاضٍ** بنص حرفي: "FUTURE: integrations engine — placeholder only, no implementation until its phase. Every permission registered here later uses the resource:action key format and sets is_sensitive = true for money-affecting actions." هذا يوثّق نية معمارية سابقة بأن التكاملات الخارجية تعيش هنا، وأن أي صلاحية جديدة لها يجب أن تتبع صيغة resource:action وتُصنَّف is_sensitive = true.

### القرار المصحَّح (Decision D-2)
- الـ port الجديد اسمه `ComplianceProviderAdapter`، يُعرَّف في `src/domain/contracts/compliance.ts` بنفس نمط tax.ts وorder-tax.ts: أنواع + interface فقط، zero dependencies خارج domain/shared، بدون أي تنفيذ.
- الواجهة تحتوي دالتين فقط على مستوى الـ port العام: `submitDocument(document, artifactStore): Promise<ComplianceSubmissionResult>` و `getStatus(externalReference): Promise<ComplianceStatusResult>`. أي تفاصيل داخلية (build/sign) تبقى تفصيل تنفيذ خاص بكل Adapter فعلي (مثل ZATCA)، لا تُعرَّض في الـ port العام.
- الاختبارات تُكتب كـ unit test عادي في test/unit/ باستخدام تنفيذ in-memory وهمي (بنفس نمط in-memory-catalog-repository.ts الموجود)، لا باسم "contract test"، حتى لا يتعارض مع تعريف contract المعماري الملزم في هذا المستودع.
- اسم "contract" يُحجز فقط لاختبارات تفحص schema حقيقي (pg catalog) إذا احتجنا لاحقًا جدول تسجيل مزوّدين (providers registry).

### الحالة
- 🟢 هذا تصحيح توثيقي فقط في هذه الجلسة. لم يُكتب أي كود بعد لـ compliance.ts. الجلسة القادمة (منفصلة) ستنفّذ الكتابة الفعلية طبقًا لهذا القرار المصحَّح.

## تنفيذ ComplianceProviderAdapter (D-2) — بتاريخ 2026-09-22

- تم تنفيذ الكود الفعلي لـ `ComplianceProviderAdapter` ودفعه إلى `origin/main` في commit `d4f6236` برسالة `feat: add compliance provider adapter port`.
- أُضيف `src/domain/contracts/compliance.ts` لتعريف عقد المجال والأنواع والـ ports الخاصة بمزوّد الامتثال.
- أُضيف `src/infrastructure/db/repositories/in-memory-compliance-provider-adapter.ts` كتطبيق وهمي in-memory لاستخدامه في اختبارات الوحدة.
- أُضيف `test/unit/compliance-provider-adapter.test.ts` لاختبار سلوك العقد والتطبيق الوهمي على مستوى الوحدة.
- تحتوي الواجهة العامة فقط على `submitDocument` و`getStatus`، ولا تعرض `buildDocument` أو `sign` كعمليتين منفصلتين، بما يطابق قرار D-2.
- يستخدم `ComplianceArtifactStore` النوع `Uint8Array` بدلًا من `Buffer` لضمان استقلالية بيئة التشغيل.
- نتائج الفحص الكامل: typecheck (exit 0)، lint (exit 0)، ومجموعة الاختبارات الكاملة 1008/1008 ناجحة.
- 🟢 هذا القسم يوثّق تنفيذًا مكتملًا ومدفوعًا؛ لا يوجد كود معلّق من D-2 حاليًا.
