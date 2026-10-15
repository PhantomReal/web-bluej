// Kleines Beispielprojekt zum Ausprobieren.
export const SAMPLE = {
  name: 'Beispiel-Konten',
  files: {
    'Konto.java': `/**
 * Ein einfaches Bankkonto.
 */
public class Konto
{
    private String inhaber;
    private int stand;

    /**
     * Legt ein Konto für einen Inhaber an.
     */
    public Konto(String inhaber)
    {
        this.inhaber = inhaber;
        this.stand = 0;
    }

    public void einzahlen(int betrag)
    {
        stand = stand + betrag;
        System.out.println(inhaber + ": " + betrag + " Euro eingezahlt.");
    }

    public boolean abheben(int betrag)
    {
        if (betrag <= stand) {
            stand = stand - betrag;
            return true;
        }
        return false;
    }

    public int getStand()
    {
        return stand;
    }

    public String getInhaber()
    {
        return inhaber;
    }
}
`,
    'Bank.java': `import java.util.ArrayList;

/**
 * Verwaltet mehrere Konten.
 */
public class Bank
{
    private ArrayList<Konto> konten;

    public Bank()
    {
        konten = new ArrayList<Konto>();
    }

    public Konto neuesKonto(String inhaber)
    {
        Konto k = new Konto(inhaber);
        konten.add(k);
        return k;
    }

    public int gesamtGuthaben()
    {
        int summe = 0;
        for (Konto k : konten) {
            summe = summe + k.getStand();
        }
        return summe;
    }

    public static void main(String[] args)
    {
        Bank b = new Bank();
        Konto k = b.neuesKonto("Anna");
        k.einzahlen(100);
        System.out.println("Gesamt: " + b.gesamtGuthaben());
    }
}
`,
  },
  layout: { Konto: { x: 40, y: 150 }, Bank: { x: 40, y: 30 } },
};
