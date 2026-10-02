const dns = require("node:dns").promises;
const net = require("node:net");

const resolveA = async (hostname, resolver = dns.resolve4) => {
  if (typeof hostname !== "string" || !/^[a-z0-9-]+\.vidkar\.com$/i.test(hostname)) {
    throw new Error("El host no pertenece al dominio permitido de VIDKAR.");
  }

  try {
    return (await resolver(hostname)).filter((address) => net.isIP(address) === 4);
  } catch (error) {
    if (["ENODATA", "ENOTFOUND", "ESERVFAIL", "ETIMEOUT"].includes(error?.code)) return [];
    throw new Error("No se pudo consultar la resolución DNS del subdominio.");
  }
};

const dnsPointsToVps = (addresses, targetIpv4) =>
  net.isIP(String(targetIpv4 || "")) === 4
  && Array.isArray(addresses)
  && addresses.length > 0
  && addresses.every((address) => net.isIP(address) === 4 && address === targetIpv4);

module.exports = { dnsPointsToVps, resolveA };
