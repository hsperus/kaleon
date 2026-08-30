/**
 * İzin ve vardiya tool'ları.
 *
 * İZİN BAKİYESİ L0'DIR AMA HERKES HERKESİNKİNİ GÖREMEZ: çalışan kendi
 * bakiyesini, müdür departmanınınkini, İK hepsini görür. Bu ayrım tool
 * seviyesinde değil, izin seviyesinde çözülür.
 *
 * ONAY L2'DİR. İzin onayı bir maliyet taahhüdüdür: kullanılmayan izin
 * karşılığı bilançoda durur ve işten ayrılışta ödenir.
 */

import { z } from "zod";
import { defineTool } from "../../kernel/tool.js";
import type { LeaveRepository } from "../../db/leave-repository.js";
import { LEAVE_TYPES, STATUTORY_LEAVE_DAYS } from "./leave.js";
import { TERMINATION_REASONS } from "./termination.js";

export function leaveTools(repo: LeaveRepository) {
  const getBalance = defineTool({
    name: "get_leave_balance",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir çalışanın yıllık izin hakkını ve kalan gününü döndürür. Hak, İş Kanunu " +
        "md. 53'e göre KIDEMDEN HESAPLANIR — tabloda saklanmaz, o yüzden kıdem yılı " +
        "dolduğunda kendiliğinden güncellenir. Onay bekleyen talepler de düşülür.",
      en: "Returns annual leave entitlement and remaining days, computed from seniority.",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
    }),
    requires: ["hr:leave.read"],
    async execute(input, ctx) {
      const b = await repo.balanceOf(input.employeeCode, ctx.now());
      return {
        ok: true as const,
        data: {
          employeeCode: b.employeeCode,
          entitled: b.entitled,
          used: b.used,
          pending: b.pending,
          remaining: b.remaining,
          basis: b.basis,
        },
        sources: [
          {
            system: "İzin kayıtları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks:
          b.entitled === 0
            ? [{ severity: "info" as const, message: b.basis }]
            : b.remaining <= 0
              ? [
                  {
                    severity: "warning" as const,
                    message: `${b.employeeCode} yıllık iznini tüketmiş; yeni yıllık izin alamaz.`,
                  },
                ]
              : [],
        confidence: 96,
      };
    },
  });

  const request = defineTool({
    name: "request_leave",
    module: "hr",
    authority: 1,
    description: {
      tr:
        "İzin talebi oluşturur. Gün sayısı İŞ GÜNÜ olarak hesaplanır: pazar ve " +
        "bildirilen resmî tatiller izinden düşülmez (İş Kanunu md. 56). Çakışan " +
        "izin ve haktan fazla talep reddedilir. Mazeret, ölüm, evlilik ve babalık " +
        "izinleri yıllık izinden DÜŞÜLMEZ.",
      en: "Creates a leave request; days are counted as working days.",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
      type: z.enum(LEAVE_TYPES).describe("İzin türü."),
      startDate: z.string().describe("Başlangıç (ISO 8601)."),
      endDate: z.string().describe("Bitiş (ISO 8601), dahil."),
      reason: z.string().max(300).nullable().describe("Açıklama. Yoksa null."),
      holidays: z
        .array(z.string())
        .describe("Aralıktaki resmî tatiller (ISO 8601). Yoksa boş dizi."),
      saturdayIsOff: z.boolean().describe("İşletmede cumartesi tatil mi?"),
    }),
    requires: ["hr:leave.write"],
    async execute(input, ctx) {
      const r = await repo.request({
        employeeCode: input.employeeCode,
        type: input.type,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        reason: input.reason,
        requestedBy: ctx.principal.userId,
        holidays: input.holidays.map((h) => new Date(h)),
        weekendDays: input.saturdayIsOff ? [0, 6] : [0],
      });

      const statutory = STATUTORY_LEAVE_DAYS[input.type];
      return {
        ok: true as const,
        data: r,
        sources: [
          {
            system: "İzin kayıtları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              `${r.startDate} – ${r.endDate} arası ${r.workingDays} iş günü izin talebi ` +
              `oluşturuldu; onay bekliyor. Talebi siz onaylayamazsınız.`,
          },
          ...(statutory !== undefined && r.workingDays > statutory
            ? [
                {
                  severity: "warning" as const,
                  message:
                    `"${input.type}" izni kanunen ${statutory} gündür; ${r.workingDays} gün ` +
                    `talep edilmiş. Aşan kısım için şirket politikası gerekir.`,
                },
              ]
            : []),
        ],
        confidence: 96,
      };
    },
  });

  const approve = defineTool({
    name: "approve_leave",
    module: "hr",
    authority: 2,
    description: {
      tr:
        "İzin talebini onaylar. KENDİ TALEBİNİZİ ONAYLAYAMAZSINIZ. Onaylanan izin " +
        "bakiyeden düşer ve o günlere vardiya atanamaz.",
      en: "Approves a leave request. Self-approval is impossible.",
    },
    input: z.strictObject({
      requestId: z.string().min(1).describe("İzin talebi kimliği."),
    }),
    requires: ["hr:leave.approve"],
    async execute(input, ctx) {
      await repo.approve(input.requestId, ctx.principal.userId);
      return {
        ok: true as const,
        data: { requestId: input.requestId, status: "approved" },
        sources: [
          {
            system: "İzin kayıtları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          {
            severity: "info" as const,
            message:
              "İzin onaylandı. Kullanılmayan izin karşılığı bilançoda durur ve " +
              "işten ayrılışta ödenir; onay bir maliyet taahhüdüdür.",
          },
        ],
        confidence: 98,
      };
    },
  });

  const defineShiftTool = defineTool({
    name: "define_shift",
    module: "hr",
    authority: 2,
    description: {
      tr:
        "Vardiya tanımlar veya günceller. KANUNÎ SINIRLAR TANIM ANINDA kontrol " +
        "edilir: gece çalışması 7,5 saati (md. 69), günlük çalışma 11 saati " +
        "(md. 63) aşamaz; ara dinlenme md. 68 asgarisinin altına inemez. " +
        "Puantajda yakalanırsa iş zaten olmuştur.",
      en: "Defines a shift; statutory limits are validated at definition time.",
    },
    input: z.strictObject({
      code: z.string().min(1).max(16).describe("Vardiya kodu: V1, GECE…"),
      name: z.string().min(2).max(80).describe("Vardiya adı."),
      startsAt: z.string().describe("Başlangıç saati, SS:DD."),
      endsAt: z.string().describe("Bitiş saati, SS:DD. Gün aşabilir."),
      breakMinutes: z.number().int().nonnegative().describe("Ara dinlenme, dakika."),
      isNight: z.boolean().describe("Gece vardiyası mı? 20:00–06:00 arasına giriyorsa evet."),
    }),
    requires: ["hr:shift.write"],
    async execute(input, _ctx) {
      const res = await repo.defineShift(input);
      return {
        ok: true as const,
        data: { code: input.code, netHours: res.hours },
        sources: [
          {
            system: "Vardiya tanımları",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: res.warnings.map((w) => ({ severity: "warning" as const, message: w })),
        confidence: res.warnings.length > 0 ? 80 : 97,
      };
    },
  });

  const assign = defineTool({
    name: "assign_shift",
    module: "hr",
    authority: 1,
    description: {
      tr:
        "Bir çalışana bir güne vardiya atar. ONAYLI İZİNDEKİ KİŞİYE VARDİYA " +
        "ATANAMAZ; bir kişi aynı gün iki vardiyada olamaz.",
      en: "Assigns a shift to an employee for a date.",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
      shiftCode: z.string().min(1).max(16).describe("Vardiya kodu."),
      workDate: z.string().describe("Tarih (ISO 8601)."),
    }),
    requires: ["hr:shift.write"],
    async execute(input, _ctx) {
      await repo.assignShift({
        employeeCode: input.employeeCode,
        shiftCode: input.shiftCode,
        workDate: new Date(input.workDate),
      });
      return {
        ok: true as const,
        data: { ...input },
        sources: [
          {
            system: "Vardiya planı",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [],
        confidence: 97,
      };
    },
  });

  const weekly = defineTool({
    name: "get_weekly_shift_plan",
    module: "hr",
    authority: 0,
    description: {
      tr:
        "Bir çalışanın bir haftalık vardiya planını ve toplam saatini döndürür; " +
        "45 saati aşan kısım fazla mesaidir (md. 63).",
      en: "Returns an employee's weekly shift plan and overtime beyond 45 hours.",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
      weekStart: z.string().describe("Hafta başlangıcı (ISO 8601)."),
    }),
    requires: ["hr:shift.read"],
    async execute(input, _ctx) {
      const plan = await repo.weeklyPlan(input.employeeCode, new Date(input.weekStart));
      return {
        ok: true as const,
        data: plan,
        sources: [
          {
            system: "Vardiya planı",
            kind: "module" as const,
            recordCount: plan.days.length,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: plan.exceedsLimit
          ? [
              {
                severity: "warning" as const,
                message:
                  `Haftalık planlanan çalışma ${plan.totalHours} saat; 45 saati ` +
                  `${plan.overtime} saat aşıyor. Aşan kısım fazla mesai olarak ` +
                  `ücretlendirilmelidir (İş Kanunu md. 41).`,
              },
            ]
          : [],
        confidence: 95,
      };
    },
  });

  const termination = defineTool({
    name: "draft_termination_settlement",
    module: "hr",
    authority: 2,
    description: {
      tr:
        "İşten çıkış TASLAĞI hazırlar: kıdem tazminatı (1475 md. 14), ihbar " +
        "tazminatı (4857 md. 17) ve kullanılmayan yıllık izin (md. 59). Hak " +
        "kazanma ÇIKIŞ SEBEBİNE bağlıdır — istifa eden kıdem alamaz, haklı fesihte " +
        "ihbar ödenmez. BU BİR TASLAKTIR: eksik ödenen tazminat faiziyle dava " +
        "konusudur, fazla ödenen geri alınamaz; İK ve mali müşavir onaylamalıdır.",
      en: "Drafts a termination settlement (severance, notice, unused leave).",
    },
    input: z.strictObject({
      employeeCode: z.string().min(1).max(64).describe("Personel kodu."),
      terminatedAt: z.string().describe("Çıkış tarihi (ISO 8601)."),
      reason: z.enum(TERMINATION_REASONS).describe("Çıkış sebebi — hak kazanmayı belirler."),
      dailyGrossWage: z
        .number()
        .positive()
        .nullable()
        .describe(
          "GİYDİRİLMİŞ brüt günlük ücret (yol, yemek, ikramiye dahil). " +
            "null ise aylık brütten türetilir ve bu eksik kalabilir.",
        ),
      severanceCeilingPerYear: z
        .number()
        .positive()
        .nullable()
        .describe("Yıllık kıdem tazminatı tavanı. Girilmezse tavansız hesaplanır."),
    }),
    requires: ["hr:termination.draft"],
    async execute(input, _ctx) {
      const d = await repo.terminationDraft({
        employeeCode: input.employeeCode,
        terminatedAt: new Date(input.terminatedAt),
        reason: input.reason,
        dailyGrossWage: input.dailyGrossWage,
        severanceCeilingPerYear: input.severanceCeilingPerYear,
      });

      return {
        ok: true as const,
        data: {
          employeeCode: d.employeeCode,
          seniorityYears: d.seniorityYears,
          seniorityMonths: d.seniorityMonths,
          earnsSeverance: d.earnsSeverance,
          severanceGross: d.severanceGross,
          severanceCapped: d.severanceCapped,
          noticeWeeks: d.noticeWeeks,
          employerOwesNotice: d.employerOwesNotice,
          noticeGross: d.noticeGross,
          unusedLeaveGross: d.unusedLeaveGross,
          totalGross: d.totalGross,
          legalBasis: d.legalBasis,
        },
        sources: [
          {
            system: "İşten çıkış hesabı",
            kind: "module" as const,
            recordCount: 1,
            syncedAt: new Date().toISOString(),
          },
        ],
        risks: [
          ...d.unknowns.map((u) => ({ severity: "warning" as const, message: u })),
          ...(d.severanceCapped
            ? [
                {
                  severity: "info" as const,
                  message:
                    "Kıdem tazminatı TAVANA takıldı; hesaplanan tutar tavan üzerinden " +
                    "sınırlandı.",
                },
              ]
            : []),
          {
            severity: "critical" as const,
            message:
              "BU BİR TASLAKTIR. Eksik ödenen tazminat faiziyle dava konusudur, fazla " +
              "ödenen geri alınamaz. İK ve mali müşavir onayı olmadan ödeme yapılmamalıdır.",
          },
        ],
        confidence: d.unknowns.length > 0 ? 60 : 85,
      };
    },
  });

  return [
    getBalance,
    request,
    approve,
    defineShiftTool,
    assign,
    weekly,
    termination,
  ] as const;
}
