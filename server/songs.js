// ---------------------------------------------------------------------------
// SYNG — the jukebox for Random mode. Famous, sing-along songs from every
// decade, tagged by the language they are sung in.
//
// Nothing here is trusted blindly: before a song is offered, the server checks
// LRCLIB actually has time-synced lyrics for it, so a missing entry only means
// that song is quietly skipped.
// ---------------------------------------------------------------------------

const raw = {
  en: `
Queen | Bohemian Rhapsody | 1975
Queen | Don't Stop Me Now | 1978
Queen | We Will Rock You | 1977
The Beatles | Hey Jude | 1968
The Beatles | Let It Be | 1970
The Beatles | Yesterday | 1965
ABBA | Dancing Queen | 1976
ABBA | Mamma Mia | 1975
Journey | Don't Stop Believin' | 1981
Bon Jovi | Livin' on a Prayer | 1986
Toto | Africa | 1982
a-ha | Take On Me | 1985
Whitney Houston | I Wanna Dance with Somebody (Who Loves Me) | 1987
Michael Jackson | Billie Jean | 1982
Michael Jackson | Beat It | 1982
Madonna | Like a Prayer | 1989
Cyndi Lauper | Girls Just Want to Have Fun | 1983
Bonnie Tyler | Total Eclipse of the Heart | 1983
Survivor | Eye of the Tiger | 1982
Gloria Gaynor | I Will Survive | 1978
Village People | Y.M.C.A. | 1978
Bee Gees | Stayin' Alive | 1977
Neil Diamond | Sweet Caroline | 1969
Elton John | Tiny Dancer | 1971
Elton John | I'm Still Standing | 1983
Eagles | Hotel California | 1976
Fleetwood Mac | Dreams | 1977
John Lennon | Imagine | 1971
Simon & Garfunkel | The Sound of Silence | 1965
The Police | Every Breath You Take | 1983
U2 | With or Without You | 1987
Guns N' Roses | Sweet Child O' Mine | 1987
Aerosmith | I Don't Want to Miss a Thing | 1998
Bill Withers | Lean on Me | 1972
Ben E. King | Stand by Me | 1961
Elvis Presley | Can't Help Falling in Love | 1961
Frank Sinatra | Fly Me to the Moon | 1964
Louis Armstrong | What a Wonderful World | 1967
The Rolling Stones | (I Can't Get No) Satisfaction | 1965
Dolly Parton | Jolene | 1973
Tears for Fears | Everybody Wants to Rule the World | 1985
Wham! | Wake Me Up Before You Go-Go | 1984
Rick Astley | Never Gonna Give You Up | 1987
The Proclaimers | I'm Gonna Be (500 Miles) | 1988
Nirvana | Smells Like Teen Spirit | 1991
Oasis | Wonderwall | 1995
Oasis | Don't Look Back in Anger | 1996
Backstreet Boys | I Want It That Way | 1999
Backstreet Boys | Everybody (Backstreet's Back) | 1997
Spice Girls | Wannabe | 1996
Britney Spears | ...Baby One More Time | 1998
Britney Spears | Toxic | 2003
Celine Dion | My Heart Will Go On | 1997
TLC | No Scrubs | 1999
Destiny's Child | Say My Name | 1999
Robbie Williams | Angels | 1997
Red Hot Chili Peppers | Californication | 1999
Kylie Minogue | Can't Get You Out of My Head | 2001
Linkin Park | In the End | 2000
Linkin Park | Numb | 2003
Green Day | Boulevard of Broken Dreams | 2004
The Killers | Mr. Brightside | 2003
Outkast | Hey Ya! | 2003
Beyoncé | Crazy in Love | 2003
Beyoncé | Single Ladies (Put a Ring on It) | 2008
Rihanna | Umbrella | 2007
Amy Winehouse | Rehab | 2006
Gnarls Barkley | Crazy | 2006
Shakira | Hips Don't Lie | 2006
Alicia Keys | No One | 2007
Coldplay | Viva La Vida | 2008
Coldplay | Yellow | 2000
Coldplay | The Scientist | 2002
Lady Gaga | Bad Romance | 2009
Lady Gaga | Poker Face | 2008
Katy Perry | Firework | 2010
Katy Perry | Roar | 2013
Adele | Rolling in the Deep | 2010
Adele | Someone Like You | 2011
Adele | Hello | 2015
Bruno Mars | Just the Way You Are | 2010
Mark Ronson | Uptown Funk | 2014
Carly Rae Jepsen | Call Me Maybe | 2011
Pharrell Williams | Happy | 2013
Avicii | Wake Me Up | 2013
Miley Cyrus | Wrecking Ball | 2013
Miley Cyrus | Party in the U.S.A. | 2009
Miley Cyrus | Flowers | 2023
Taylor Swift | Shake It Off | 2014
Taylor Swift | Love Story | 2008
Taylor Swift | You Belong With Me | 2008
Justin Bieber | Sorry | 2015
Justin Bieber | Baby | 2010
Ed Sheeran | Shape of You | 2017
Ed Sheeran | Perfect | 2017
Sia | Chandelier | 2014
Sam Smith | Stay With Me | 2014
Hozier | Take Me to Church | 2013
OneRepublic | Counting Stars | 2013
Imagine Dragons | Believer | 2017
Imagine Dragons | Radioactive | 2012
Maroon 5 | Sugar | 2015
Arctic Monkeys | Do I Wanna Know? | 2013
Lady Gaga | Shallow | 2018
Lewis Capaldi | Someone You Loved | 2018
Billie Eilish | bad guy | 2019
The Weeknd | Blinding Lights | 2019
Tones And I | Dance Monkey | 2019
Dua Lipa | Levitating | 2020
Dua Lipa | Don't Start Now | 2019
Olivia Rodrigo | drivers license | 2021
Olivia Rodrigo | good 4 u | 2021
Glass Animals | Heat Waves | 2020
Harry Styles | As It Was | 2022
Harry Styles | Watermelon Sugar | 2019
Benson Boone | Beautiful Things | 2024
Sabrina Carpenter | Espresso | 2024
Chappell Roan | Good Luck, Babe! | 2024
`,
  es: `
Luis Fonsi | Despacito | 2017
Enrique Iglesias | Bailando | 2014
Enrique Iglesias | Héroe | 2002
Shakira | La Tortura | 2005
Shakira | Ojos Así | 1998
Shakira | Chantaje | 2016
Shakira | Loca | 2010
Carlos Vives | La Bicicleta | 2016
Ricky Martin | María | 1995
Ricky Martin | La Copa de la Vida | 1998
Juanes | La Camisa Negra | 2004
Juanes | A Dios le Pido | 2002
Maná | Rayando el Sol | 1990
Maná | Oye Mi Amor | 1992
Maná | Clavado en un Bar | 1997
Alejandro Sanz | Corazón Partío | 1997
Daddy Yankee | Gasolina | 2004
Daddy Yankee | Con Calma | 2019
J Balvin | Mi Gente | 2017
Bad Bunny | Tití Me Preguntó | 2022
Bad Bunny | Me Porto Bonito | 2022
Bad Bunny | DÁKITI | 2020
Karol G | Provenza | 2022
Karol G | TQG | 2023
Rosalía | Malamente | 2018
Rosalía | DESPECHÁ | 2022
Camilo | Vida de Rico | 2020
Sebastián Yatra | Tacones Rojos | 2021
Morat | Cómo Te Atreves | 2015
Estopa | Como Camarón | 1999
La Oreja de Van Gogh | Rosas | 2003
Mecano | Hijo de la Luna | 1986
Mecano | La Fuerza del Destino | 1988
El Canto del Loco | Zapatillas | 2005
Los Del Rio | Macarena | 1993
Selena | Como la Flor | 1992
Selena | Bidi Bidi Bom Bom | 1994
Gloria Estefan | Mi Tierra | 1993
Celia Cruz | La Vida Es un Carnaval | 1998
Marc Anthony | Vivir Mi Vida | 2013
Juan Luis Guerra | Burbujas de Amor | 1990
Soda Stereo | De Música Ligera | 1990
Héroes del Silencio | Entre Dos Tierras | 1990
Julio Iglesias | Me Olvidé de Vivir | 1978
Nino Bravo | Libre | 1972
Camilo Sesto | Vivir Así Es Morir de Amor | 1978
Luis Miguel | La Incondicional | 1989
Luis Miguel | Ahora Te Puedes Marchar | 1987
Thalía | Amor a la Mexicana | 1997
Paulina Rubio | Y Yo Sigo Aquí | 2000
RBD | Rebelde | 2004
Chayanne | Torero | 2002
Manu Chao | Me Gustas Tú | 2001
Bebe | Malo | 2004
Pablo Alborán | Solamente Tú | 2011
Melendi | Caminando por la Vida | 2005
Nicky Jam | El Perdón | 2015
Romeo Santos | Propuesta Indecente | 2013
Prince Royce | Darte un Beso | 2013
Vicente Fernández | Volver, Volver | 1972
Juan Gabriel | Querida | 1984
Café Tacvba | Eres | 2003
Julieta Venegas | Me Voy | 2006
Jesse & Joy | ¡Corre! | 2011
Natalia Lafourcade | Hasta la Raíz | 2015
Quevedo | Columbia | 2023
Rauw Alejandro | Todo de Ti | 2021
Eslabon Armado | Ella Baila Sola | 2023
`,
  pt: `
Michel Teló | Ai Se Eu Te Pego | 2011
Anitta | Show das Poderosas | 2013
Jorge Ben Jor | Mas Que Nada | 1963
Tim Maia | Descobridor dos Sete Mares | 1983
Gusttavo Lima | Balada | 2011
Marília Mendonça | Infiel | 2016
Legião Urbana | Tempo Perdido | 1986
Legião Urbana | Pais e Filhos | 1989
Caetano Veloso | Sozinho | 1998
Seu Jorge | Burguesinha | 2007
Kaoma | Lambada | 1989
Ivete Sangalo | Sorte Grande | 2003
Djavan | Oceano | 1989
Skank | Garota Nacional | 1996
Marisa Monte | Amor I Love You | 2000
Charlie Brown Jr. | Só os Loucos Sabem | 2009
`,
  fr: `
Stromae | Alors on danse | 2009
Stromae | Papaoutai | 2013
Édith Piaf | La Vie en rose | 1947
Édith Piaf | Non, je ne regrette rien | 1960
Indila | Dernière danse | 2013
Joe Dassin | Les Champs-Élysées | 1969
Zaz | Je veux | 2010
Aya Nakamura | Djadja | 2018
Angèle | Balance ton quoi | 2019
Céline Dion | Pour que tu m'aimes encore | 1995
Jacques Brel | Ne me quitte pas | 1959
Charles Aznavour | La Bohème | 1965
Louane | Jour 1 | 2015
Kendji Girac | Andalouse | 2014
Dalida | Paroles, paroles | 1973
Mylène Farmer | Désenchantée | 1991
Francis Cabrel | Je l'aime à mourir | 1979
`,
  it: `
Domenico Modugno | Nel blu dipinto di blu | 1958
Måneskin | Zitti e buoni | 2021
Laura Pausini | La solitudine | 1993
Eros Ramazzotti | Più bella cosa | 1996
Adriano Celentano | Azzurro | 1968
Toto Cutugno | L'italiano | 1983
Umberto Tozzi | Ti amo | 1977
Umberto Tozzi | Gloria | 1979
Lucio Dalla | Caruso | 1986
Andrea Bocelli | Con te partirò | 1995
Vasco Rossi | Albachiara | 1979
Mahmood | Soldi | 2019
Raffaella Carrà | A far l'amore comincia tu | 1976
Tiziano Ferro | Perdono | 2001
Al Bano & Romina Power | Felicità | 1982
Ricchi E Poveri | Sarà perché ti amo | 1981
Mahmood | Brividi | 2022
`,
  de: `
Nena | 99 Luftballons | 1983
Rammstein | Du hast | 1997
Rammstein | Sonne | 2001
Helene Fischer | Atemlos durch die Nacht | 2013
Falco | Der Kommissar | 1982
Peter Fox | Haus am See | 2008
Andreas Bourani | Auf uns | 2014
Tim Bendzko | Nur noch kurz die Welt retten | 2011
Die Toten Hosen | Tage wie diese | 2012
Wolfgang Petry | Wahnsinn | 1983
Herbert Grönemeyer | Männer | 1984
Mark Forster | Chöre | 2016
Cro | Easy | 2011
Silbermond | Das Beste | 2006
Juli | Perfekte Welle | 2004
Udo Jürgens | Griechischer Wein | 1974
DJ Ötzi | Ein Stern (... der deinen Namen trägt) | 2007
`,
};

export const LANGUAGES = [
  { iso: 'en', name: 'English' },
  { iso: 'es', name: 'Español' },
  { iso: 'pt', name: 'Português' },
  { iso: 'fr', name: 'Français' },
  { iso: 'it', name: 'Italiano' },
  { iso: 'de', name: 'Deutsch' },
];

export const SONGS = Object.entries(raw).flatMap(([lang, block]) =>
  block.trim().split('\n').map((line) => {
    const [artist, title, year] = line.split('|').map((s) => s.trim());
    return { id: `${lang}:${artist}:${title}`.toLowerCase(), lang, artist, title, year: Number(year) || null };
  }),
);

/** Songs in any of the given languages, minus ones already played this game. */
export function pool(langs, exclude = new Set()) {
  const want = new Set((langs && langs.length ? langs : ['en']));
  return SONGS.filter((s) => want.has(s.lang) && !exclude.has(s.id));
}
