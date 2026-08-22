#define _POSIX_C_SOURCE 200112L

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>
typedef SOCKET socket_t;
typedef int socket_length_t;
#define CLOSESOCKET closesocket
#define GETPID _getpid
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
typedef socklen_t socket_length_t;
#define CLOSESOCKET close
#define GETPID getpid
#define INVALID_SOCKET -1
#define SOCKET_ERROR -1
#endif

static double process_cpu_seconds(void) {
#ifdef _WIN32
    FILETIME created, exited, kernel, user;
    ULARGE_INTEGER kernel_time, user_time;
    if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return -1.0;
    kernel_time.LowPart = kernel.dwLowDateTime;
    kernel_time.HighPart = kernel.dwHighDateTime;
    user_time.LowPart = user.dwLowDateTime;
    user_time.HighPart = user.dwHighDateTime;
    return (double)(kernel_time.QuadPart + user_time.QuadPart) / 10000000.0;
#else
    return (double)clock() / CLOCKS_PER_SEC;
#endif
}

static uint64_t wall_nanoseconds(void) {
#ifdef _WIN32
    LARGE_INTEGER counter, frequency;
    if (!QueryPerformanceCounter(&counter) || !QueryPerformanceFrequency(&frequency)) return 0;
    return (uint64_t)((double)counter.QuadPart * 1000000000.0 / (double)frequency.QuadPart);
#else
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
    return (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
#endif
}

static int send_all(socket_t socket, const char *buffer, int length) {
    int sent = 0;
    while (sent < length) {
        int count = send(socket, buffer + sent, length - sent, 0);
        if (count == SOCKET_ERROR) {
#ifndef _WIN32
            if (errno == EINTR) continue;
#endif
            return 0;
        }
        sent += count;
    }
    return 1;
}

static int receive_datagram(
    socket_t socket,
    char *buffer,
    int capacity,
    struct sockaddr_storage *peer,
    socket_length_t *peer_size
) {
    for (;;) {
        int count = recvfrom(socket, buffer, capacity, 0, (struct sockaddr *)peer, peer_size);
        if (count != SOCKET_ERROR) return count;
#ifndef _WIN32
        if (errno == EINTR) continue;
#endif
        return SOCKET_ERROR;
    }
}

static int reflect_received(
    socket_t socket,
    const char *buffer,
    int length,
    struct sockaddr_storage *peer,
    socket_length_t peer_size,
    uint64_t *bytes_in,
    uint64_t *bytes_out,
    uint64_t *messages_in,
    uint64_t *messages_out
) {
    if (sendto(socket, buffer, length, 0, (struct sockaddr *)peer, peer_size) != length) return 0;
    *bytes_in += (uint64_t)length;
    *bytes_out += (uint64_t)length;
    *messages_in += 1;
    *messages_out += 1;
    return 1;
}

static int reflect_datagrams(
    socket_t socket,
    uint64_t count,
    char *buffer,
    int capacity,
    uint64_t *bytes_in,
    uint64_t *bytes_out,
    uint64_t *messages_in,
    uint64_t *messages_out
) {
    for (uint64_t index = 0; index < count; index += 1) {
        struct sockaddr_storage peer;
        socket_length_t peer_size = sizeof(peer);
        int length = receive_datagram(socket, buffer, capacity, &peer, &peer_size);
        if (length == SOCKET_ERROR) return 0;
        if (!reflect_received(
            socket, buffer, length, &peer, peer_size,
            bytes_in, bytes_out, messages_in, messages_out
        )) return 0;
    }
    return 1;
}

int main(int argc, char **argv) {
    const char *host = "127.0.0.1";
    const char *port = "0";
    const char *transport = "tcp";
    uint64_t expected_messages = 0;
    uint64_t measure_after = 0;
    struct addrinfo hints;
    struct addrinfo *addresses = NULL;
    socket_t listener = INVALID_SOCKET;
    socket_t client = INVALID_SOCKET;
    uint64_t bytes_in = 0;
    uint64_t bytes_out = 0;
    uint64_t messages_in = 0;
    uint64_t messages_out = 0;
    char buffer[65536];
    double cpu_start = process_cpu_seconds();
    uint64_t wall_start = wall_nanoseconds();
    double measured_cpu_start = -1.0;
    uint64_t measured_wall_start = 0;

    if ((argc - 1) % 2 != 0) return 2;
    for (int i = 1; i < argc - 1; i += 2) {
        if (strcmp(argv[i], "--host") == 0) host = argv[i + 1];
        else if (strcmp(argv[i], "--port") == 0) port = argv[i + 1];
        else if (strcmp(argv[i], "--transport") == 0) transport = argv[i + 1];
        else if (strcmp(argv[i], "--messages") == 0) {
            char *end = NULL;
            expected_messages = strtoull(argv[i + 1], &end, 10);
            if (!end || *end != '\0') return 2;
        }
        else if (strcmp(argv[i], "--measure-after") == 0) {
            char *end = NULL;
            measure_after = strtoull(argv[i + 1], &end, 10);
            if (!end || *end != '\0') return 2;
        }
        else return 2;
    }
    int datagram = strcmp(transport, "udp4") == 0 || strcmp(transport, "udp6") == 0;
    if (!datagram && strcmp(transport, "tcp") != 0) return 2;
    if (datagram && (expected_messages == 0 || measure_after >= expected_messages)) return 2;
    if (strcmp(transport, "udp4") == 0 && strcmp(host, "127.0.0.1") != 0) return 2;
    if (strcmp(transport, "udp6") == 0 && strcmp(host, "::1") != 0) return 2;
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 1;
#endif
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = strcmp(transport, "udp6") == 0 ? AF_INET6 : AF_INET;
    hints.ai_socktype = datagram ? SOCK_DGRAM : SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    if (getaddrinfo(host, port, &hints, &addresses) != 0) return 1;

    listener = socket(addresses->ai_family, addresses->ai_socktype, addresses->ai_protocol);
    if (listener == INVALID_SOCKET) return 1;
    if (bind(listener, addresses->ai_addr, (int)addresses->ai_addrlen) == SOCKET_ERROR) return 1;
    freeaddrinfo(addresses);
    struct sockaddr_storage bound;
#ifdef _WIN32
    int bound_size = sizeof(bound);
#else
    socklen_t bound_size = sizeof(bound);
#endif
    if (getsockname(listener, (struct sockaddr *)&bound, &bound_size) == SOCKET_ERROR) return 1;
    unsigned bound_port = bound.ss_family == AF_INET6
        ? (unsigned)ntohs(((struct sockaddr_in6 *)&bound)->sin6_port)
        : (unsigned)ntohs(((struct sockaddr_in *)&bound)->sin_port);
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("{\"type\":\"ready\",\"pid\":%d,\"host\":\"%s\",\"port\":%u}\n",
        (int)GETPID(), host, bound_port);

    if (datagram) {
        struct sockaddr_storage peer;
        socket_length_t peer_size = sizeof(peer);
        int length;
        if (!reflect_datagrams(
            listener, measure_after, buffer, sizeof(buffer),
            &bytes_in, &bytes_out, &messages_in, &messages_out
        )) return 1;
        length = receive_datagram(listener, buffer, sizeof(buffer), &peer, &peer_size);
        if (length == SOCKET_ERROR) return 1;
        measured_cpu_start = process_cpu_seconds();
        measured_wall_start = wall_nanoseconds();
        if (!reflect_received(
            listener, buffer, length, &peer, peer_size,
            &bytes_in, &bytes_out, &messages_in, &messages_out
        )) return 1;
        if (!reflect_datagrams(
            listener, expected_messages-measure_after-1, buffer, sizeof(buffer),
            &bytes_in, &bytes_out, &messages_in, &messages_out
        )) return 1;
        double measured_cpu_end = process_cpu_seconds();
        uint64_t measured_wall_end = wall_nanoseconds();
        CLOSESOCKET(listener);
#ifdef _WIN32
        WSACleanup();
#endif
        double cpu_end = process_cpu_seconds();
        uint64_t wall_end = wall_nanoseconds();
        double cpu_seconds = cpu_start >= 0.0 && cpu_end >= 0.0 ? cpu_end - cpu_start : -1.0;
        double measured_cpu_seconds = measured_cpu_start >= 0.0 && measured_cpu_end >= 0.0
            ? measured_cpu_end - measured_cpu_start
            : -1.0;
        printf("{\"type\":\"cleanup\",\"acceptedConnections\":0,\"activeSocketsAfterClose\":0,"
            "\"bytesIn\":%llu,\"bytesOut\":%llu,\"destroyedSockets\":0,"
            "\"messagesIn\":%llu,\"messagesOut\":%llu,\"cpuSeconds\":%.9f,\"wallNs\":\"%llu\","
            "\"measuredCpuSeconds\":%.9f,\"measuredWallNs\":\"%llu\"}\n",
            (unsigned long long)bytes_in, (unsigned long long)bytes_out,
            (unsigned long long)messages_in, (unsigned long long)messages_out,
            cpu_seconds, (unsigned long long)(wall_end - wall_start),
            measured_cpu_seconds, (unsigned long long)(measured_wall_end - measured_wall_start));
        return 0;
    }

    if (listen(listener, 1) == SOCKET_ERROR) return 1;

    client = accept(listener, NULL, NULL);
    if (client == INVALID_SOCKET) return 1;
    {
        int enabled = 1;
        setsockopt(client, IPPROTO_TCP, TCP_NODELAY, (const char *)&enabled, sizeof(enabled));
    }
    for (;;) {
        int count = recv(client, buffer, sizeof(buffer), 0);
        if (count == 0) break;
        if (count == SOCKET_ERROR) {
#ifndef _WIN32
            if (errno == EINTR) continue;
#endif
            return 1;
        }
        if (!send_all(client, buffer, count)) return 1;
        bytes_in += (uint64_t)count;
        bytes_out += (uint64_t)count;
    }
    CLOSESOCKET(client);
    CLOSESOCKET(listener);
#ifdef _WIN32
    WSACleanup();
#endif
    double cpu_end = process_cpu_seconds();
    uint64_t wall_end = wall_nanoseconds();
    double cpu_seconds = cpu_start >= 0.0 && cpu_end >= 0.0 ? cpu_end - cpu_start : -1.0;
    printf("{\"type\":\"cleanup\",\"acceptedConnections\":1,\"activeSocketsAfterClose\":0,"
        "\"bytesIn\":%llu,\"bytesOut\":%llu,\"destroyedSockets\":0,"
        "\"messagesIn\":0,\"messagesOut\":0,\"cpuSeconds\":%.9f,\"wallNs\":\"%llu\"}\n",
        (unsigned long long)bytes_in, (unsigned long long)bytes_out,
        cpu_seconds, (unsigned long long)(wall_end - wall_start));
    return 0;
}
