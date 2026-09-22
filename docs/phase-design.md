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
